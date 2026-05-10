/* =====================================================
   MICROJOY v1.4 — app.js (Dashboard Edition)
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


// ===== §2b. DEBUG PANEL =====
const debugPanel = document.getElementById('debugPanel');
const debugContent = document.getElementById('debugContent');
const MAX_DEBUG_LINES = 100;

function debugLog(tag, message) {
    if (!debugContent) return;
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const line = document.createElement('div');
    line.className = 'debug-line';
    const tagClass = tag === 'RX' ? 'debug-tag-rx' : tag === 'TX' ? 'debug-tag-tx' : 'debug-tag-info';
    line.innerHTML = `<span class="debug-time">${time}</span><span class="debug-tag ${tagClass}">${tag}</span>${escapeHtml(message)}`;
    debugContent.appendChild(line);
    while (debugContent.children.length > MAX_DEBUG_LINES) {
        debugContent.removeChild(debugContent.firstChild);
    }
    debugContent.scrollTop = debugContent.scrollHeight;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const brandEl = document.querySelector('.brand');
let tapCount = 0;
let tapTimer = null;
if (brandEl) {
    brandEl.addEventListener('click', () => {
        tapCount++;
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => { tapCount = 0; }, 600);
        if (tapCount >= 3) {
            tapCount = 0;
            debugPanel.hidden = !debugPanel.hidden;
            if (!debugPanel.hidden) {
                debugLog('INFO', 'Debug panel opened');
                toast('Debug ON');
            }
        }
    });
}

document.getElementById('debugClear')?.addEventListener('click', () => {
    debugContent.innerHTML = '';
    debugLog('INFO', 'Log cleared');
});
document.getElementById('debugClose')?.addEventListener('click', () => {
    debugPanel.hidden = true;
});


// ===== §3. TOGGLE TELEMETRI =====
// Pengguna boleh sembunyikan paparan telemetri untuk view yang lebih bersih
const TELEMETRY_VISIBLE_KEY = 'microjoy.telemetryVisible';
const telemetryStack = document.getElementById('telemetryStack');
const btnToggleTelemetry = document.getElementById('btnToggleTelemetry');

let telemetryVisible = true;
try {
    const saved = localStorage.getItem(TELEMETRY_VISIBLE_KEY);
    if (saved !== null) telemetryVisible = saved === 'true';
} catch {}

function applyTelemetryVisibility() {
    telemetryStack.dataset.visible = String(telemetryVisible);
    btnToggleTelemetry.classList.toggle('active', telemetryVisible);
    try { localStorage.setItem(TELEMETRY_VISIBLE_KEY, String(telemetryVisible)); } catch {}
}

btnToggleTelemetry.addEventListener('click', () => {
    telemetryVisible = !telemetryVisible;
    haptic(15);
    applyTelemetryVisibility();
    toast(telemetryVisible ? 'Telemetry ON' : 'Telemetry OFF');
});

applyTelemetryVisibility();


// ===== §4. MODE TOGGLE (Joystick / D-Pad) =====
let isDpadMode = false;
const btnToggle = document.getElementById('btnToggleMode');
const joyHitbox = document.getElementById('joystickHitbox');
const dpZone   = document.getElementById('dpadZone');
const telemetryMode = document.getElementById('telemetryMode');
const modeValue = document.getElementById('modeValue');

function updateModeIndicator(mode) {
    telemetryMode.hidden = false;
    modeValue.textContent = mode;
}

btnToggle.addEventListener('click', () => {
    isDpadMode = !isDpadMode;
    haptic(15);
    if (isDpadMode) {
        joyHitbox.style.display = 'none';
        dpZone.style.display = 'block';
        toast('D-pad mode');
        updateModeIndicator('dpad');
    } else {
        joyHitbox.style.display = 'flex';
        dpZone.style.display = 'none';
        toast('Joystick mode');
        updateModeIndicator('analog');
    }
    cX = 0; cY = 0;
    keyState.up = keyState.down = keyState.left = keyState.right = false;
    forceKineticUpdate();
});


// ===== §5. FULLSCREEN =====
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


// ===== §6. WAKE LOCK =====
let wakeLock = null;

async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {});
    } catch (err) {
        console.warn('Wake lock failed:', err);
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}


// ===== §7. BLE: Connect, Disconnect, Auto-reconnect =====
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const UART_TX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

const STORAGE_KEY = 'microjoy.lastDeviceName';

let bleDevice = null;
let rxChar = null;
let txChar = null;
let isConnected = false;

const statusEl     = document.getElementById('status');
const telOut       = document.getElementById('telemetryOut');
const telOutValue  = telOut.querySelector('.tel-value');
const telIn        = document.getElementById('telemetryIn');
const telInValue   = telIn.querySelector('.tel-value');
const batteryPill  = document.getElementById('batteryIndicator');
const batteryValue = document.getElementById('batteryValue');
const batteryRing  = document.getElementById('batteryRing');
const connBtn      = document.getElementById('btnConnect');
const reconnBtn    = document.getElementById('btnReconnect');

// === Element references untuk battery panel ===
const batteryPanel = document.getElementById('batteryPanel');
const batteryPanelClose = document.getElementById('batteryPanelClose');
const bpPercent = document.getElementById('bpPercent');
const bpVoltage = document.getElementById('bpVoltage');
const bpTrend = document.getElementById('bpTrend');
const bpRange = document.getElementById('bpRange');
const bpSparkLine = document.getElementById('bpSparkLine');
const bpSparkArea = document.getElementById('bpSparkArea');

// === Signal indicator ===
const signalIndicator = document.getElementById('signalIndicator');
const signalLabel = document.getElementById('signalLabel');

// === Connection menu ===
const statusPill = document.getElementById('statusPill');
const connectionMenu = document.getElementById('connectionMenu');
const connectionMenuClose = document.getElementById('connectionMenuClose');
const cmCurrentName = document.getElementById('cmCurrentName');
const cmSwitch = document.getElementById('cmSwitch');
const cmDisconnect = document.getElementById('cmDisconnect');

// Lilitan cincin = 2π × radius (radius = 18, jadi keliling = 113.097)
const RING_CIRCUMFERENCE = 2 * Math.PI * 18;

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

    // Kemaskini teks peratus
    batteryValue.textContent = `${Math.round(percent)}`;
    batteryPill.hidden = false;

    // Kemaskini cincin progress
    const offset = RING_CIRCUMFERENCE - (percent / 100) * RING_CIRCUMFERENCE;
    batteryRing.style.strokeDashoffset = offset;

    // Tetapkan tahap (warna)
    let level = 'high';
    if (percent < 20) level = 'low';
    else if (percent < 50) level = 'mid';
    batteryPill.dataset.level = level;
    batteryPanel.dataset.level = level;

    // Kemaskini panel terperinci
    bpPercent.textContent = Math.round(percent);
    updateBatteryTrend(percent);
}

function setBatteryVoltage(volt) {
    if (typeof volt !== 'number' || isNaN(volt)) return;
    bpVoltage.textContent = volt.toFixed(2);
    addVoltageReading(volt);
}

// === Sparkline & Voltage History ===
const MAX_HISTORY = 30; // Simpan 30 bacaan terakhir
const voltageHistory = [];
let lastBatteryReading = null;
let trendBuffer = [];

function addVoltageReading(volt) {
    voltageHistory.push(volt);
    if (voltageHistory.length > MAX_HISTORY) {
        voltageHistory.shift();
    }
    renderSparkline();
    updateVoltageRange();
}

function renderSparkline() {
    if (voltageHistory.length < 2) {
        bpSparkLine.setAttribute('d', '');
        bpSparkArea.setAttribute('d', '');
        return;
    }

    const W = 300;
    const H = 80;
    const PAD = 4;
    const min = Math.min(...voltageHistory);
    const max = Math.max(...voltageHistory);
    const range = max - min || 0.1;

    const points = voltageHistory.map((v, i) => {
        const x = PAD + (i / (MAX_HISTORY - 1)) * (W - PAD * 2);
        const y = H - PAD - ((v - min) / range) * (H - PAD * 2);
        return [x, y];
    });

    // Garis utama (smooth bezier)
    let linePath = `M ${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const cpX = (prev[0] + curr[0]) / 2;
        linePath += ` Q ${cpX} ${prev[1]} ${cpX} ${(prev[1] + curr[1]) / 2}`;
        linePath += ` Q ${cpX} ${curr[1]} ${curr[0]} ${curr[1]}`;
    }
    bpSparkLine.setAttribute('d', linePath);

    // Area di bawah garis (untuk gradient)
    const areaPath = linePath +
        ` L ${points[points.length - 1][0]} ${H}` +
        ` L ${points[0][0]} ${H} Z`;
    bpSparkArea.setAttribute('d', areaPath);
}

function updateVoltageRange() {
    if (voltageHistory.length === 0) {
        bpRange.textContent = '— V';
        return;
    }
    const min = Math.min(...voltageHistory);
    const max = Math.max(...voltageHistory);
    bpRange.textContent = `${min.toFixed(2)} – ${max.toFixed(2)} V`;
}

function updateBatteryTrend(percent) {
    trendBuffer.push(percent);
    if (trendBuffer.length > 6) trendBuffer.shift();

    if (trendBuffer.length < 3) {
        bpTrend.textContent = '—';
        bpTrend.className = 'bp-stat-value trend-stable';
        return;
    }

    // Kira purata pertama dan terakhir untuk trend
    const firstAvg = (trendBuffer[0] + trendBuffer[1]) / 2;
    const lastAvg = (trendBuffer[trendBuffer.length - 1] + trendBuffer[trendBuffer.length - 2]) / 2;
    const diff = lastAvg - firstAvg;

    if (Math.abs(diff) < 1) {
        bpTrend.textContent = 'stable';
        bpTrend.className = 'bp-stat-value trend-stable';
    } else if (diff > 0) {
        bpTrend.textContent = '↑';
        bpTrend.className = 'bp-stat-value trend-up';
    } else {
        bpTrend.textContent = '↓';
        bpTrend.className = 'bp-stat-value trend-down';
    }
}

// === Battery panel toggle ===
batteryPill.addEventListener('click', () => {
    haptic(15);
    batteryPanel.hidden = !batteryPanel.hidden;
});

batteryPanelClose.addEventListener('click', () => {
    haptic(15);
    batteryPanel.hidden = true;
});

// Tutup panel kalau tap luar
document.addEventListener('click', (e) => {
    if (batteryPanel.hidden) return;
    if (batteryPanel.contains(e.target)) return;
    if (batteryPill.contains(e.target)) return;
    batteryPanel.hidden = true;
});


// === Penunjuk Kekuatan Isyarat (berdasarkan latency) ===
let pingHistory = [];
let lastPingTime = 0;

function recordLatency(ms) {
    pingHistory.push(ms);
    if (pingHistory.length > 5) pingHistory.shift();
    updateSignalStrength();
}

function updateSignalStrength() {
    if (pingHistory.length === 0) {
        signalIndicator.hidden = true;
        return;
    }

    const avg = pingHistory.reduce((a, b) => a + b, 0) / pingHistory.length;
    let strength;
    let label;

    // Kira aras berdasarkan kependaman purata
    // BLE biasa 20-50ms = excellent, 50-100 = good, 100-200 = fair, >200 = poor
    if (avg < 60) {
        strength = 4;
        label = 'Excellent';
    } else if (avg < 120) {
        strength = 3;
        label = 'Good';
    } else if (avg < 250) {
        strength = 2;
        label = 'Fair';
    } else {
        strength = 1;
        label = 'Poor';
    }

    signalIndicator.dataset.strength = String(strength);
    signalLabel.textContent = `${Math.round(avg)}ms`;
    signalIndicator.hidden = false;
    signalIndicator.title = `${label} — ${Math.round(avg)}ms latency`;
}

function clearSignalStrength() {
    pingHistory = [];
    signalIndicator.hidden = true;
}


// === Menu Sambungan ===
// Status pill berfungsi sebagai butang menu apabila telah bersambung.
// Pengguna boleh tukar robot atau memutuskan sambungan dengan mudah.
statusPill.addEventListener('click', () => {
    if (!isConnected) return; // Hanya berfungsi apabila telah bersambung
    haptic(15);
    connectionMenu.hidden = !connectionMenu.hidden;
    if (!connectionMenu.hidden) {
        cmCurrentName.textContent = bleDevice?.name || 'Unknown device';
    }
});

connectionMenuClose.addEventListener('click', () => {
    haptic(15);
    connectionMenu.hidden = true;
});

// Tutup menu apabila tap luar
document.addEventListener('click', (e) => {
    if (connectionMenu.hidden) return;
    if (connectionMenu.contains(e.target)) return;
    if (statusPill.contains(e.target)) return;
    connectionMenu.hidden = true;
});

// Tukar ke robot lain dalam satu langkah
cmSwitch.addEventListener('click', async () => {
    haptic(15);
    connectionMenu.hidden = true;
    
    // Putuskan sambungan semasa dahulu
    if (bleDevice?.gatt.connected) {
        bleDevice.gatt.disconnect();
    }
    
    // Beri masa untuk disconnect selesai sepenuhnya
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Buka dialog pemilihan peranti baharu
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
        } else {
            toast('Error: ' + (err.message || err.name));
        }
    }
});

// Putuskan sambungan
cmDisconnect.addEventListener('click', () => {
    haptic(15);
    connectionMenu.hidden = true;
    if (bleDevice?.gatt.connected) {
        bleDevice.gatt.disconnect();
    }
});

function updateConnectedUI(connected, deviceName) {
    isConnected = connected;
    if (connected) {
        statusEl.textContent = deviceName ? `${deviceName}` : 'Connected';
        document.body.classList.add('is-connected');
        connBtn.textContent = 'Disconnect';
        reconnBtn.hidden = true;
        setTxTelemetry('ready');
        updateModeIndicator(isDpadMode ? 'dpad' : 'analog');
    } else {
        statusEl.textContent = 'Offline';
        document.body.classList.remove('is-connected');
        connBtn.textContent = 'Connect';
        setTxTelemetry('disconnected');
        telIn.hidden = true;
        batteryPill.hidden = true;
        telemetryMode.hidden = true;
    }
}

function onDisconnected() {
    rxChar = null;
    txChar = null;
    updateConnectedUI(false);
    releaseWakeLock();
    clearSignalStrength();
    batteryPanel.hidden = true;
    connectionMenu.hidden = true;
    voltageHistory.length = 0;
    trendBuffer.length = 0;
    stopPingLoop();
    toast('Connection lost');
}

// === Ping loop untuk pengukuran latency ===
let pingInterval = null;
const PING_INTERVAL_MS = 3000;

function startPingLoop() {
    stopPingLoop();
    pingInterval = setInterval(() => {
        if (!isConnected || !rxChar) return;
        if (lastPingTime > 0) return; // Masih tunggu pong sebelum
        lastPingTime = Date.now();
        send('ping\n');
        // Timeout — kalau tiada respons dalam 1 saat, kira sebagai poor
        setTimeout(() => {
            if (lastPingTime > 0 && Date.now() - lastPingTime > 1000) {
                recordLatency(1000);
                lastPingTime = 0;
            }
        }, 1100);
    }, PING_INTERVAL_MS);
}

function stopPingLoop() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    lastPingTime = 0;
}


async function connectToDevice(device) {
    bleDevice = device;
    bleDevice.addEventListener('gattserverdisconnected', onDisconnected);

    connBtn.textContent = 'Connecting…';
    const server  = await device.gatt.connect();
    const service = await server.getPrimaryService(UART_SERVICE_UUID);

    rxChar = await service.getCharacteristic(UART_RX_CHAR_UUID);

    try {
        txChar = await service.getCharacteristic(UART_TX_CHAR_UUID);
        txChar.addEventListener('characteristicvaluechanged', handleIncomingData);
        await txChar.startNotifications();
        debugLog('INFO', 'TX channel ready — listening for data');
    } catch (err) {
        console.warn('TX channel not available:', err);
        debugLog('INFO', 'TX channel FAILED: ' + err.message);
        txChar = null;
    }

    updateConnectedUI(true, device.name);
    requestWakeLock();
    toast('Connected');

    try { localStorage.setItem(STORAGE_KEY, device.name); } catch {}

    await send('mode_analog\n');
    
    // Mulakan ping loop untuk pengukuran kekuatan isyarat
    startPingLoop();
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

async function checkSavedDevice() {
    if (!navigator.bluetooth?.getDevices) return;

    let savedName = null;
    try { savedName = localStorage.getItem(STORAGE_KEY); } catch {}

    try {
        const devices = await navigator.bluetooth.getDevices();
        if (devices.length === 0) return;

        const target = devices.find(d => d.name === savedName) || devices[0];
        if (!target) return;

        reconnBtn.textContent = `Reconnect`;
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
                reconnBtn.textContent = `Reconnect`;
            }
        };
    } catch (err) {
        console.warn('getDevices() failed:', err);
    }
}


// ===== §8. INBOUND UART =====
let rxBuffer = '';

function handleIncomingData(event) {
    const chunk = new TextDecoder().decode(event.target.value);
    rxBuffer += chunk;

    let lines = rxBuffer.split('\n');
    rxBuffer = lines.pop();

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
            debugLog('RX', trimmed);
            parseRxLine(trimmed);
        }
    }
}

function parseRxLine(line) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();

        if (key === 'battery' || key === 'bat') {
            const num = parseFloat(value);
            debugLog('INFO', `Battery: ${num}%`);
            setBatteryLevel(num);
            return;
        }
        if (key === 'volt' || key === 'voltage' || key === 'v') {
            const num = parseFloat(value);
            debugLog('INFO', `Voltage: ${num}V`);
            setBatteryVoltage(num);
            return;
        }
        if (key === 'pong') {
            // Respons dari micro:bit untuk pengukuran latency
            if (lastPingTime > 0) {
                const latency = Date.now() - lastPingTime;
                recordLatency(latency);
                lastPingTime = 0;
            }
            return;
        }
        setRxTelemetry(`${key}:${value}`);
        return;
    }
    setRxTelemetry(line);
}


// ===== §9. SEND PIPELINE =====
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


// ===== §10. JOYSTICK ENGINE =====
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


// ===== §11. D-PAD ENGINE =====
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


// ===== §12. ACTION BUTTONS =====
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


// ===== §13. KEYBOARD =====
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


// ===== §14. SERVICE WORKER =====
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
}


// ===== §15. VISIBILITY =====
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (isConnected) requestWakeLock();
    } else {
        if (isConnected) {
            cX = 0; cY = 0;
            keyState.up = keyState.down = keyState.left = keyState.right = false;
            forceKineticUpdate();
        }
    }
});


// ===== INIT =====
checkSavedDevice();
