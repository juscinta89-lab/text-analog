/* =====================================================
   MICROJOY — app.js
   Bahagian-bahagian:
     §1  Haptic helpers
     §2  Toast notifications
     §3  Mode toggle (joystick ↔ d-pad)
     §4  Fullscreen
     §5  BLE connection
     §6  Send pipeline (with backpressure)
     §7  Joystick engine
     §8  D-pad engine
     §9  Action buttons (A / B)
     §10 Keyboard support (UNIFIED — fixes the double-listener bug)
     §11 Service worker
   ===================================================== */

// ---------- §1. HAPTIC ----------
function haptic(ms) {
    if (navigator.vibrate) navigator.vibrate(ms);
}

// ---------- §2. TOAST ----------
// Toast sentiasa nampak bila ada error/info — user tak teka-teka apa jadi.
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg, duration = 2400) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

// ---------- §3. MODE TOGGLE ----------
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
    // Reset semua state bila tukar mode supaya tiada "stuck input"
    cX = 0; cY = 0;
    keyState.up = keyState.down = keyState.left = keyState.right = false;
    forceKineticUpdate();
});

// ---------- §4. FULLSCREEN ----------
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
    } catch (err) {
        toast('Fullscreen blocked by browser');
    }
});

// ---------- §5. BLE ----------
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

let bleDevice = null;
let rxChar = null;
let isConnected = false;

const statusEl  = document.getElementById('status');
const telEl     = document.getElementById('telemetryOut');
const telValue  = telEl.querySelector('.telemetry-value');
const connBtn   = document.getElementById('btnConnect');

function setTelemetry(text) {
    if (telValue) telValue.textContent = text;
}

function onDisconnected() {
    isConnected = false;
    rxChar = null;
    statusEl.textContent = 'Offline';
    document.body.classList.remove('is-connected');
    connBtn.textContent = 'Connect';
    setTelemetry('disconnected');
    toast('Connection lost');
}

connBtn.addEventListener('click', async () => {
    // Disconnect dulu kalau dah bersambung
    if (bleDevice?.gatt.connected) {
        bleDevice.gatt.disconnect();
        return;
    }

    // Periksa support — beri pesanan jelas kepada user
    if (!navigator.bluetooth) {
        toast('Web Bluetooth not supported');
        return;
    }

    try {
        connBtn.textContent = 'Scanning…';
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: 'BBC' },
                { namePrefix: 'micro:bit' },
            ],
            optionalServices: [UART_SERVICE_UUID],
        });

        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);

        connBtn.textContent = 'Connecting…';
        const server  = await bleDevice.gatt.connect();
        const service = await server.getPrimaryService(UART_SERVICE_UUID);
        rxChar        = await service.getCharacteristic(UART_RX_CHAR_UUID);

        isConnected = true;
        statusEl.textContent = 'Online';
        document.body.classList.add('is-connected');
        connBtn.textContent = 'Disconnect';
        setTelemetry('ready');
        toast('Connected');

        await send('mode_analog\n');
    } catch (err) {
        connBtn.textContent = 'Connect';
        // Bezakan jenis error supaya user faham
        if (err.name === 'NotFoundError') {
            toast('No device selected');
        } else if (err.name === 'NetworkError') {
            toast('Connection failed');
        } else {
            toast('Error: ' + err.message);
        }
        console.error('BLE Error:', err);
    }
});

// ---------- §6. SEND PIPELINE (backpressure-safe) ----------
let cX = 0, cY = 0;
let lX, lY;
let isWriting = false;
let pendingMessage = null;

async function send(payload) {
    setTelemetry(payload.replace(/\n/g, ''));
    if (!rxChar || !isConnected) return;

    // Kalau tengah hantar, simpan satu pending sahaja (latest wins).
    // Ini elak GATT queue overflow.
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

// ---------- §7. JOYSTICK ENGINE ----------
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

// ---------- §8. D-PAD ENGINE ----------
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

// ---------- §9. ACTION BUTTONS ----------
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

// ---------- §10. KEYBOARD (UNIFIED — bug fix) ----------
/*
    BUG ASAL: Ada DUA blok keydown/keyup yang berebut update cX/cY.
              Blok 1 guna `activeKeys{}` dan handle a/b langsung.
              Blok 2 guna `keyState{}` dan handle j/k langsung.
              Bila kedua-duanya jalan, forceKineticUpdate() dipanggil 2 kali setiap event.
              Lebih buruk: blok 1 set cY=0 bila lepaskan ArrowUp tanpa kira ArrowDown.

    PEMBETULAN: SATU sumber kebenaran — `keyState` object.
                Setiap event hanya update keyState, lepas tu kira cX/cY dari state.
                Multi-key combinations bekerja secara natural.
*/

const keyState = { up: false, down: false, left: false, right: false };
const pressedActions = new Set(); // elak repeat fire bila kekunci ditahan

function recomputeFromKeyboard() {
    let nx = 0, ny = 0;
    // "Latest priority": kalau dua-dua up & down, jadikan 0 (lebih selamat)
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
    if (!el) return;
    el.classList.toggle('active-toggle', on);
}

window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    let consumed = false;

    // Arrow keys → directional state
    if (k === 'arrowup')    { keyState.up = true;    setDpadVisual('up', true);    consumed = true; }
    if (k === 'arrowdown')  { keyState.down = true;  setDpadVisual('down', true);  consumed = true; }
    if (k === 'arrowleft')  { keyState.left = true;  setDpadVisual('left', true);  consumed = true; }
    if (k === 'arrowright') { keyState.right = true; setDpadVisual('right', true); consumed = true; }
    if (consumed) recomputeFromKeyboard();

    // Action keys (A=a/j, B=b/k) — guard against key-repeat
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

// Bila tab kehilangan fokus, lepaskan semua kekunci (elak input "stuck")
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

// ---------- §11. SERVICE WORKER ----------
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
}
