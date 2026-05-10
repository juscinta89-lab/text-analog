/* =====================================================
   MICROJOY — app.js v2 (Sales Edition)
   Bahagian-bahagian:
     §1  Haptic
     §2  Toast notifications
     §3  Mode toggle (joystick ↔ d-pad)
     §4  Fullscreen
     §5  Wake Lock                                    ← BARU
     §6  BLE: Connect, Disconnect, Auto-reconnect    ← BARU (auto-reconnect)
     §7  BLE: TX (incoming data dari micro:bit)      ← BARU (bidirectional)
     §8  Send pipeline (with backpressure)
     §9  Joystick engine
     §10 D-pad engine
     §11 Action buttons (A / B)
     §12 Keyboard support (state-driven, unified)
     §13 Service worker
     §14 Visibility/lifecycle handling
   ===================================================== */


// ===== §1. HAPTIC =====
function haptic(ms) {
    if (navigator.vibrate) navigator.vibrate(ms);
}


// ===== §2. TOAST =====
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg, duration = 2400) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}


// ===== §3. MODE TOGGLE =====
let isDpadMode = false;
const btnToggle = document.getElementById('btnToggleMode');
const joyHitbox = document.getElementById('joystickHitbox');
const dpZone   = document.getElementById('dpadZone');

btnToggle.addEventListener('click', () => {
    isDpadMode = !isDpadMode;
    haptic(15);
    if (isDpadMode) {
        joyHitbox.style.display = 'none';
        dpZone.style.display = 'block';
        toast('D-pad mode');
    } else {
        joyHitbox.style.display = 'flex';
        dpZone.style.display = 'none';
        toast('Joystick mode');
    }
    cX = 0; cY = 0;
    keyState.up = keyState.down = keyState.left = keyState.right = false;
    forceKineticUpdate();
});


// ===== §4. FULLSCREEN =====
const btnFs = document.getElementById('btnFullscreen');
btnFs.addEventListener('click', async () => {
    try {
        if (!document.fullscreenElement) {
            await document.documentElement.requestFullscreen();
            if (screen.orientation?.lock) {
                try { await screen.orientation.lock('landscape'); } catch {}
            }
        } else {
            await document.exitFullscreen();
            if (screen.orientation?.unlock) screen.orientation.unlock();
        }
    } catch {
        toast('Fullscreen blocked by browser');
    }
});


// ===== §5. WAKE LOCK =====
/*
    Wake lock = mintak browser jangan tidurkan skrin.
    Pelepasan automatik bila tab tak active — kena minta semula bila visible.
    API: navigator.wakeLock.request('screen')
    Support: Chrome/Edge desktop & Android, Safari iOS 16.4+
*/
let wakeLock = null;

async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            // Sentinel released — bukan masalah, biasa berlaku bila tab background
        });
    } catch (err) {
        // Mungkin gagal dalam mod private browsing atau bila batteri rendah
        console.warn('Wake lock failed:', err);
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}


// ===== §6. BLE: Connect, Disconnect, Auto-reconnect =====
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';  // Phone → micro:bit
const UART_TX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';  // micro:bit → Phone

const STORAGE_KEY = 'microjoy.lastDeviceName';

let bleDevice = null;
let rxChar = null;
let txChar = null;
let isConnected = false;

const statusEl     = document.getElementById('status');
const telOut       = document.getElementById('telemetryOut');
const telOutValue  = telOut.querySelector('.telemetry-value');
const telIn        = document.getElementById('telemetryIn');
const telInValue   = telIn.querySelector('.telemetry-value');
const batteryPill  = document.getElementById('batteryIndicator');
const batteryValue = document.getElementById('batteryValue');
const connBtn      = document.getElementById('btnConnect');
const reconnBtn    = document.getElementById('btnReconnect');

function setTxTelemetry(text) {
    if (telOutValue) telOutValue.textContent = text;
}
function setRxTelemetry(text) {
    if (telInValue) telInValue.textContent = text;
    telIn.hidden = false;
}

function setBatteryLevel(percent) {
    if (typeof percent !== 'number' || isNaN(percent)) return;
    percent = Math.max(0, Math.min(100, percent));
    batteryValue.textContent = `${Math.round(percent)}%`;
    batteryPill.hidden = false;
    let level = 'high';
    if (percent < 20) level = 'low';
    else if (percent < 50) level = 'mid';
    batteryPill.dataset.level = level;
}

function updateConnectedUI(connected, deviceName) {
    isConnected = connected;
    if (connected) {
        statusEl.textContent = deviceName ? `Online · ${deviceName}` : 'Online';
        document.body.classList.add('is-connected');
        connBtn.textContent = 'Disconnect';
        reconnBtn.hidden = true;
        setTxTelemetry('ready');
    } else {
        statusEl.textContent = 'Offline';
        document.body.classList.remove('is-connected');
        connBtn.textContent = 'Connect';
        setTxTelemetry('disconnected');
        // Sembunyikan inbound pills (data tak relevan bila offline)
        telIn.hidden = true;
        batteryPill.hidden = true;
    }
}

function onDisconnected() {
    rxChar = null;
    txChar = null;
    updateConnectedUI(false);
    releaseWakeLock();
    toast('Connection lost');
}

async function connectToDevice(device) {
    bleDevice = device;
    bleDevice.addEventListener('gattserverdisconnected', onDisconnected);

    connBtn.textContent = 'Connecting…';
    const server  = await device.gatt.connect();
    const service = await server.getPrimaryService(UART_SERVICE_UUID);

    // Setup RX (kita hantar)
    rxChar = await service.getCharacteristic(UART_RX_CHAR_UUID);

    // Setup TX (kita terima) — wrapped in try/catch sebab device tertentu mungkin tak support
    try {
        txChar = await service.getCharacteristic(UART_TX_CHAR_UUID);
        txChar.addEventListener('characteristicvaluechanged', handleIncomingData);
        await txChar.startNotifications();
    } catch (err) {
        console.warn('TX channel not available:', err);
        txChar = null;
    }

    updateConnectedUI(true, device.name);
    requestWakeLock();
    toast('Connected');

    // Simpan nama untuk reconnect
    try { localStorage.setItem(STORAGE_KEY, device.name); } catch {}

    await send('mode_analog\n');
}

connBtn.addEventListener('click', async () => {
    if (bleDevice?.gatt.connected) {
        bleDevice.gatt.disconnect();
        return;
    }
    if (!navigator.bluetooth) {
        toast('Web Bluetooth not supported');
        return;
    }
    try {
        connBtn.textContent = 'Scanning…';
        const device = await navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: 'BBC' },
                { namePrefix: 'micro:bit' },
            ],
            optionalServices: [UART_SERVICE_UUID],
        });
        await connectToDevice(device);
    } catch (err) {
        connBtn.textContent = 'Connect';
        if (err.name === 'NotFoundError') {
            toast('No device selected');
        } else if (err.name === 'NetworkError') {
            toast('Connection failed — try again');
        } else {
            toast('Error: ' + (err.message || err.name));
        }
        console.error('BLE Error:', err);
    }
});

// === Auto-reconnect: cek devices yang user pernah benarkan ===
/*
    navigator.bluetooth.getDevices() return devices yang user pernah pair
    dalam masa lepas (chrome://bluetooth-internals untuk debug).
    Browser tak benarkan auto-connect — user kena click sekali (security).
*/
async function checkSavedDevice() {
    if (!navigator.bluetooth?.getDevices) return; // Older browsers tak support

    let savedName = null;
    try { savedName = localStorage.getItem(STORAGE_KEY); } catch {}

    try {
        const devices = await navigator.bluetooth.getDevices();
        if (devices.length === 0) return;

        // Cari device yang match nama yang disimpan, atau ambil first available
        const target = devices.find(d => d.name === savedName) || devices[0];
        if (!target) return;

        reconnBtn.textContent = `Reconnect ${target.name || 'device'}`;
        reconnBtn.hidden = false;
        reconnBtn.onclick = async () => {
            try {
                reconnBtn.disabled = true;
                reconnBtn.textContent = 'Connecting…';
                await connectToDevice(target);
            } catch (err) {
                toast('Reconnect failed — try Connect');
                console.error(err);
                reconnBtn.disabled = false;
                reconnBtn.textContent = `Reconnect ${target.name || 'device'}`;
            }
        };
    } catch (err) {
        // Kalau getDevices gagal, ignore senyap-senyap (bukan error kritikal)
        console.warn('getDevices() failed:', err);
    }
}


// ===== §7. BLE: Inbound (TX) — terima data dari micro:bit =====
/*
    Format yang kita expect dari micro:bit (boleh customize):
        "battery:78"     → battery 78%
        "dist:12.5"      → distance sensor 12.5
        "temp:24"        → temperature 24°C
        sebarang string lain → tunjuk dalam RX pill
    micro:bit MakeCode contoh:
        bluetooth.uart_write_string("battery:" + battery_level + "\n")
*/

let rxBuffer = '';

function handleIncomingData(event) {
    const chunk = new TextDecoder().decode(event.target.value);
    rxBuffer += chunk;

    // Pecahkan ikut newline (data boleh tiba sebagai chunks)
    let lines = rxBuffer.split('\n');
    rxBuffer = lines.pop(); // simpan baki yang belum lengkap

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) parseRxLine(trimmed);
    }
}

function parseRxLine(line) {
    // Cuba parse "key:value" format
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();

        if (key === 'battery' || key === 'bat') {
            setBatteryLevel(parseFloat(value));
            return;
        }
        // Lain-lain key → display dalam RX pill
        setRxTelemetry(`${key}:${value}`);
        return;
    }

    // Bukan key:value → display sebagai-adanya
    setRxTelemetry(line);
}


// ===== §8. SEND PIPELINE (backpressure-safe) =====
let cX = 0, cY = 0;
let lX, lY;
let isWriting = false;
let pendingMessage = null;

async function send(payload) {
    setTxTelemetry(payload.replace(/\n/g, ''));
    if (!rxChar || !isConnected) return;

    if (isWriting) {
        pendingMessage = payload;
        return;
    }

    isWriting = true;
    try {
        await rxChar.writeValue(new TextEncoder().encode(payload));
    } catch (err) {
        console.warn('GATT write error:', err);
    }
    isWriting = false;

    if (pendingMessage) {
        const next = pendingMessage;
        pendingMessage = null;
        send(next);
    }
}

const fmt = (v) => (v >= 0 ? '+' : '-') + Math.abs(v).toString().padStart(2, '0');

function forceKineticUpdate() {
    if (cX !== lX || cY !== lY) {
        send(`X${fmt(cX)},Y${fmt(cY)}\n`);
        lX = cX; lY = cY;
    }
}


// ===== §9. JOYSTICK ENGINE =====
const base  = document.getElementById('joystickBase');
const thumb = document.getElementById('thumbstick');

let activePointerId = null;
let originX = 0, originY = 0;
let currentMaxRadius = 80;
let edgeHitLock = false;
let wasReversing = false;

function handleThumbMove(clientX, clientY) {
    let dx = clientX - originX;
    let dy = clientY - originY;
    const dist = Math.hypot(dx, dy);

    if (dist >= currentMaxRadius) {
        dx *= currentMaxRadius / dist;
        dy *= currentMaxRadius / dist;
        if (!edgeHitLock) {
            haptic(30);
            base.classList.add('max-throttle');
            edgeHitLock = true;
        }
    } else if (dist < currentMaxRadius * 0.85) {
        if (edgeHitLock) {
            base.classList.remove('max-throttle');
            edgeHitLock = false;
        }
    }

    thumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    cX = Math.round((dx / currentMaxRadius) * 90);
    cY = Math.round((-dy / currentMaxRadius) * 90);

    if (cY < -5 && !wasReversing) { haptic(15); wasReversing = true; }
    else if (cY > 5 && wasReversing) { haptic(15); wasReversing = false; }

    forceKineticUpdate();
}

joyHitbox.addEventListener('pointerdown', (e) => {
    if (activePointerId !== null) return;
    activePointerId = e.pointerId;
    joyHitbox.setPointerCapture(activePointerId);
    haptic(20);
    base.classList.add('active');

    const r = base.getBoundingClientRect();
    originX = r.left + r.width / 2;
    originY = r.top + r.height / 2;
    currentMaxRadius = r.width / 2;

    cX = 0; cY = 0;
    edgeHitLock = false; wasReversing = false;
    handleThumbMove(e.clientX, e.clientY);
});
joyHitbox.addEventListener('pointermove', (e) => {
    if (activePointerId !== e.pointerId) return;
    handleThumbMove(e.clientX, e.clientY);
});

function resetJoystick(e) {
    if (activePointerId !== e.pointerId) return;
    activePointerId = null;
    base.classList.remove('active', 'max-throttle');
    thumb.style.transform = 'translate(-50%, -50%)';
    cX = 0; cY = 0;
    edgeHitLock = false; wasReversing = false;
    forceKineticUpdate();
}
joyHitbox.addEventListener('pointerup', resetJoystick);
joyHitbox.addEventListener('pointercancel', resetJoystick);


// ===== §10. D-PAD ENGINE =====
function bindDpad(id, axis, val) {
    const el = document.getElementById(id);
    let pid = null;
    el.addEventListener('pointerdown', (e) => {
        if (pid !== null) return;
        pid = e.pointerId; el.setPointerCapture(pid);
        haptic(15);
        el.classList.add('active-toggle');
        if (axis === 'x') cX = val;
        if (axis === 'y') cY = val;
        forceKineticUpdate();
    });
    function release(e) {
        if (pid !== e.pointerId) return;
        pid = null;
        el.classList.remove('active-toggle');
        if (axis === 'x') cX = 0;
        if (axis === 'y') cY = 0;
        forceKineticUpdate();
    }
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
}
bindDpad('btnUp',    'y',  90);
bindDpad('btnDown',  'y', -90);
bindDpad('btnLeft',  'x', -90);
bindDpad('btnRight', 'x',  90);


// ===== §11. ACTION BUTTONS =====
function bindAction(id, char) {
    const el = document.getElementById(id);
    let pid = null;
    el.addEventListener('pointerdown', (e) => {
        if (pid !== null) return;
        pid = e.pointerId; el.setPointerCapture(pid);
        haptic(15);
        send(char.toUpperCase() + '\n');
        el.classList.add('active-toggle');
    });
    function release(e) {
        if (pid !== e.pointerId) return;
        pid = null;
        send(char.toLowerCase() + '\n');
        el.classList.remove('active-toggle');
    }
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
}
bindAction('btnA', 'a');
bindAction('btnB', 'b');


// ===== §12. KEYBOARD (UNIFIED, state-driven) =====
const keyState = { up: false, down: false, left: false, right: false };
const pressedActions = new Set();

function recomputeFromKeyboard() {
    let nx = 0, ny = 0;
    if (keyState.up   && !keyState.down)  ny =  90;
    if (keyState.down && !keyState.up)    ny = -90;
    if (keyState.left && !keyState.right) nx = -90;
    if (keyState.right && !keyState.left) nx =  90;
    cX = nx; cY = ny;
    forceKineticUpdate();
}

function setDpadVisual(dir, on) {
    const map = { up: 'btnUp', down: 'btnDown', left: 'btnLeft', right: 'btnRight' };
    const el = document.getElementById(map[dir]);
    if (el) el.classList.toggle('active-toggle', on);
}

window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    let consumed = false;

    if (k === 'arrowup')    { keyState.up = true;    setDpadVisual('up', true);    consumed = true; }
    if (k === 'arrowdown')  { keyState.down = true;  setDpadVisual('down', true);  consumed = true; }
    if (k === 'arrowleft')  { keyState.left = true;  setDpadVisual('left', true);  consumed = true; }
    if (k === 'arrowright') { keyState.right = true; setDpadVisual('right', true); consumed = true; }
    if (consumed) recomputeFromKeyboard();

    if ((k === 'a' || k === 'j') && !pressedActions.has('a')) {
        pressedActions.add('a');
        document.getElementById('btnA').classList.add('active-toggle');
        send('A\n');
        consumed = true;
    }
    if ((k === 'b' || k === 'k') && !pressedActions.has('b')) {
        pressedActions.add('b');
        document.getElementById('btnB').classList.add('active-toggle');
        send('B\n');
        consumed = true;
    }

    if (consumed) e.preventDefault();
});

window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    let consumed = false;

    if (k === 'arrowup')    { keyState.up = false;    setDpadVisual('up', false);    consumed = true; }
    if (k === 'arrowdown')  { keyState.down = false;  setDpadVisual('down', false);  consumed = true; }
    if (k === 'arrowleft')  { keyState.left = false;  setDpadVisual('left', false);  consumed = true; }
    if (k === 'arrowright') { keyState.right = false; setDpadVisual('right', false); consumed = true; }
    if (consumed) recomputeFromKeyboard();

    if ((k === 'a' || k === 'j') && pressedActions.has('a')) {
        pressedActions.delete('a');
        document.getElementById('btnA').classList.remove('active-toggle');
        send('a\n');
        consumed = true;
    }
    if ((k === 'b' || k === 'k') && pressedActions.has('b')) {
        pressedActions.delete('b');
        document.getElementById('btnB').classList.remove('active-toggle');
        send('b\n');
        consumed = true;
    }

    if (consumed) e.preventDefault();
});

window.addEventListener('blur', () => {
    keyState.up = keyState.down = keyState.left = keyState.right = false;
    pressedActions.forEach((act) => {
        const id = act === 'a' ? 'btnA' : 'btnB';
        document.getElementById(id).classList.remove('active-toggle');
        send(act + '\n');
    });
    pressedActions.clear();
    ['btnUp', 'btnDown', 'btnLeft', 'btnRight'].forEach(id => {
        document.getElementById(id).classList.remove('active-toggle');
    });
    recomputeFromKeyboard();
});


// ===== §13. SERVICE WORKER =====
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
}


// ===== §14. VISIBILITY / LIFECYCLE =====
/*
    Bila tab balik visible:
      - Re-request wake lock kalau dah connected (sebab wake lock dilepaskan auto)
    Bila tab jadi hidden:
      - Hentikan input ke micro:bit (elak "stuck input" bila user switch app)
*/
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (isConnected) requestWakeLock();
    } else {
        // Hentikan robot bila app keluar focus — safety first
        if (isConnected) {
            cX = 0; cY = 0;
            keyState.up = keyState.down = keyState.left = keyState.right = false;
            forceKineticUpdate();
        }
    }
});


// ===== INIT =====
// Cek device tersimpan bila app load — tunjuk butang reconnect kalau ada
checkSavedDevice();
