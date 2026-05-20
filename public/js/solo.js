'use strict';

// ── Settings persistence ───────────────────────────────────────
const LS = 'camnet.solo.';
function lsSave(key, val) {
  try { localStorage.setItem(LS + key, JSON.stringify(val)); } catch {}
}
function lsLoad(key, fallback) {
  try {
    const raw = localStorage.getItem(LS + key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

// ── Motion detection sensitivity thresholds ────────────────────
const SENS = {
  low:   { pixelDiff: 35, fraction: 0.025 },
  mid:   { pixelDiff: 25, fraction: 0.012 },
  high:  { pixelDiff: 18, fraction: 0.006 },
  ultra: { pixelDiff: 10, fraction: 0.003 },
};

// ── AI smart detection (same lazy-promise pattern as viewer.js) ─
let soloCocoModel         = null;
let soloCocoLoadingPromise = null;
const SMART_COOLDOWN_MS    = 3_000;
const SMART_CLASS_OPTIONS  = [
  { value: 'person',     label: '🚶 Person',    defaultOn: true },
  { value: 'car',        label: '🚗 Car' },
  { value: 'motorcycle', label: '🏍 Motorcycle' },
  { value: 'bicycle',    label: '🚲 Bicycle' },
  { value: 'truck',      label: '🚛 Truck' },
  { value: 'bus',        label: '🚌 Bus' },
  { value: 'dog',        label: '🐕 Dog' },
  { value: 'cat',        label: '🐈 Cat' },
];

// ── State ──────────────────────────────────────────────────────
let localStream    = null;
let facingMode     = 'environment';
let mediaBusy      = false;
let armed          = false;
let wakeLock       = null;

// Motion
let motionRunning  = false;
let motionCanvas   = null;
let motionCtx      = null;
let motionPrev     = null;
let motionConsec   = 0;
let lastAlertAt    = 0;
let pendingSmartDetect = false;
let lastSmartAt    = 0;

// Recording
const SEG_MS = 5 * 60 * 1000;
let recorder       = null;
let recordActive   = false;
let recordChunks   = [];
let recordSegNum   = 0;
let recordSegTimer = null;
let recordBaseName = '';
let recordIdleTimer = null;    // for "record on motion → stop after idle"
let recordOnMotion  = false;   // if true, auto-start/stop recording on motion events

// Flash strobe
let flashMode      = 'off';   // 'off' | 'steady' | 'slow' | 'fast'
let flashDurSecs   = 30;       // 0 = until dismissed
let flashStrobeTimer = null;   // strobe interval handle
let flashOffTimer    = null;   // auto-off timeout
let flashTorchOn     = false;  // current torch state

// Alarm
let alarmMode      = 'off';    // 'off' | 'beep' | 'tone'
let alarmCtx       = null;
let alarmNode      = null;
let alarmGain      = null;

// ── Persisted settings ─────────────────────────────────────────
let sens           = lsLoad('sens',        'mid');
let consec         = lsLoad('consec',       3);
let cooldownSecs   = lsLoad('cooldown',    30);
let smartEnabled   = lsLoad('smartEnabled', false);
let smartClasses   = new Set(lsLoad('smartClasses', ['person']));
let smartConfidence = lsLoad('smartConfidence', 0.5);
let motionFlashMode = lsLoad('motionFlashMode', 'off');
let motionFlashDur  = lsLoad('motionFlashDur',   30);
alarmMode          = lsLoad('alarmMode',    'off');
recordOnMotion     = lsLoad('recordOnMotion', false);
let recordIdleSecs = lsLoad('recordIdleSecs', 60);
let ntfyUrl        = lsLoad('ntfyUrl',      '');

// ── Boot: start camera immediately ────────────────────────────
(async () => {
  await initMedia();
  restoreUI();
  if (smartEnabled) loadCocoModel().catch(() => {});
})();

// ── Media ──────────────────────────────────────────────────────
async function initMedia() {
  if (mediaBusy) return;
  mediaBusy = true;
  try {
    if (localStream) localStream.getTracks().forEach(t => t.stop());

    const videoConstraints = {
      facingMode: { ideal: facingMode },
      width:  { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    };

    let audioErr1;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e1) {
      audioErr1 = e1.name + ': ' + e1.message;
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: true });
      } catch (e2) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
        } catch (e3) {
          try { window.AndroidBridge?.logDiagnostic?.('solo initMedia failed: ' + e3.message); } catch (_) {}
          showToast('Camera unavailable — check permissions');
          return;
        }
      }
    }

    if (audioErr1) {
      try { window.AndroidBridge?.logDiagnostic?.('solo audio t1 failed: ' + audioErr1); } catch (_) {}
    }

    const vid = document.getElementById('soloVideo');
    vid.srcObject = localStream;
    vid.classList.toggle('mirror', facingMode === 'user');

    // Restart motion loop if armed
    if (armed && !motionRunning) startMotionLoop();
  } finally {
    mediaBusy = false;
  }
}

// ── Arm / Disarm ───────────────────────────────────────────────
async function setArmed(on) {
  armed = on;
  if (on) {
    startMotionLoop();
    await requestWakeLock();
    window.AndroidBridge?.startStreaming?.();
    setStatus('ARMED', 'Monitoring…');
    updateMotionIndicator();
  } else {
    stopMotionLoop();
    stopFlash();
    stopAlarm();
    stopRecordingIfActive();
    clearTimeout(recordIdleTimer); recordIdleTimer = null;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    window.AndroidBridge?.stopStreaming?.();
    setStatus('DISARMED', 'Tap 🔴 to arm');
    updateMotionIndicator();
    hideAlertBanner();
  }
  const btn = document.getElementById('soloArmBtn');
  btn.classList.toggle('armed', armed);
  btn.querySelector('span').textContent = armed ? 'Disarm' : 'Arm';
  btn.querySelector('.ctrl-icon').textContent = armed ? '🟢' : '🔴';
}

document.getElementById('soloArmBtn').addEventListener('click', () => setArmed(!armed));

// ── Motion detection loop ──────────────────────────────────────
function startMotionLoop() {
  if (motionRunning) return;
  const video = document.getElementById('soloVideo');
  if (!video || !localStream) return;
  motionRunning = true;
  motionPrev    = null;
  motionConsec  = 0;

  if (!motionCanvas) {
    motionCanvas = document.createElement('canvas');
    motionCanvas.style.display = 'none';
    document.getElementById('soloPreview').appendChild(motionCanvas);
    motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });
  }

  analyzeFrame();
}

function stopMotionLoop() {
  motionRunning = false;
  motionPrev    = null;
  motionConsec  = 0;
  if (motionCanvas) { motionCanvas.remove(); motionCanvas = null; motionCtx = null; }
}

// ── Point-in-polygon (ray casting — same as viewer.js) ────────
function pointInPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    if ((yi > py) !== (yj > py) &&
        px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Zone state (persisted as normalized polygon or null)
let motionZone = lsLoad('zone', null);

function analyzeFrame() {
  if (!motionRunning) return;
  const video = document.getElementById('soloVideo');
  const W = 160, H = 120;

  if (!video || video.videoWidth === 0) { setTimeout(analyzeFrame, 500); return; }

  motionCanvas.width  = W;
  motionCanvas.height = H;
  motionCtx.drawImage(video, 0, 0, W, H);
  const frame = motionCtx.getImageData(0, 0, W, H).data;

  if (motionPrev) {
    const { pixelDiff, fraction } = SENS[sens] || SENS.mid;
    const zone = motionZone;
    let changed = 0, total = 0;

    if (zone && zone.type === 'polygon' && zone.points?.length >= 3) {
      const pts = zone.points;
      for (let y = 0; y < H; y++) {
        const ny = y / H;
        for (let x = 0; x < W; x++) {
          if (pointInPolygon(x / W, ny, pts)) {
            const i = (y * W + x) * 4;
            const d = (Math.abs(frame[i]-motionPrev[i]) +
                       Math.abs(frame[i+1]-motionPrev[i+1]) +
                       Math.abs(frame[i+2]-motionPrev[i+2])) / 3;
            if (d > pixelDiff) changed++;
            total++;
          }
        }
      }
    } else {
      total = W * H;
      for (let i = 0; i < frame.length; i += 4) {
        const d = (Math.abs(frame[i]-motionPrev[i]) +
                   Math.abs(frame[i+1]-motionPrev[i+1]) +
                   Math.abs(frame[i+2]-motionPrev[i+2])) / 3;
        if (d > pixelDiff) changed++;
      }
    }

    const now = Date.now();
    const aboveThreshold = total > 0 && changed / total > fraction;

    if (aboveThreshold) {
      motionConsec++;
    } else {
      motionConsec = 0;
    }

    if (motionConsec >= consec && now >= lastAlertAt + cooldownSecs * 1000) {
      motionConsec = 0;
      if (smartEnabled && soloCocoModel && !pendingSmartDetect &&
          now >= lastSmartAt + SMART_COOLDOWN_MS) {
        // AI mode: run inference, use class label when confident, fall back to
        // basic alert when AI draws a blank — AI labels rather than gates.
        lastSmartAt        = now;
        pendingSmartDetect = true;
        runSmartDetect(video).then(matches => {
          pendingSmartDetect = false;
          if (matches && matches.length > 0) {
            const best = matches.reduce((a, b) => a.score > b.score ? a : b);
            onMotionDetected(best.class);
          } else {
            // AI found nothing recognized — still alert so motion isn't silently dropped.
            onMotionDetected(null);
          }
        });
      } else if (!smartEnabled || !soloCocoModel || pendingSmartDetect) {
        // AI off, model not loaded yet, or previous inference still running → basic alert.
        onMotionDetected(null);
      }
    }
  }

  motionPrev = frame.slice();
  setTimeout(analyzeFrame, 400);
}

function onMotionDetected(detectedClass) {
  lastAlertAt = Date.now();

  // UI alert
  showAlertBanner(detectedClass);
  setTimeout(hideAlertBanner, 4000);

  // Native Android notification
  fireNativeAlert(detectedClass);

  // Remote push (ntfy) — always includes a 320px JPEG snapshot regardless
  // of local recording/snapshot settings so remote viewers can see what triggered.
  const url = ntfyUrl.trim();
  if (url) {
    const label = detectedClass
      ? detectedClass.charAt(0).toUpperCase() + detectedClass.slice(1) + ' detected'
      : 'Motion detected';
    const body = label + ' — ' + new Date().toLocaleTimeString();
    window.AndroidBridge?.sendWebhookNotification?.(url, 'Motion detected — CamNet Solo', body, captureMotionSnap());
  }

  // Flash on motion
  if (motionFlashMode !== 'off') triggerMotionFlash();

  // Audio alarm
  if (alarmMode !== 'off') triggerAlarm();

  // Record on motion
  if (recordOnMotion && !recordActive) {
    startRecording();
    clearTimeout(recordIdleTimer); recordIdleTimer = null;
  }
  if (recordOnMotion && recordActive && recordIdleSecs > 0) {
    clearTimeout(recordIdleTimer);
    recordIdleTimer = setTimeout(() => {
      stopRecordingIfActive();
      showToast('Recording stopped — no motion');
    }, recordIdleSecs * 1000);
  }
}

// ── AI model loading ───────────────────────────────────────────
function loadScript(src, opts = {}) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    if (opts.crossOrigin) s.crossOrigin = opts.crossOrigin;
    s.onload  = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function loadCocoModel() {
  if (soloCocoModel) return soloCocoModel;
  if (soloCocoLoadingPromise) return soloCocoLoadingPromise;
  soloCocoLoadingPromise = (async () => {
    updateSmartStatus('Loading TensorFlow…');
    if (!window.tf) {
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
        { crossOrigin: 'anonymous' });
    }
    updateSmartStatus('Loading detection model…');
    if (!window.cocoSsd) {
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js',
        { crossOrigin: 'anonymous' });
    }
    updateSmartStatus('Warming up…');
    soloCocoModel = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
    updateSmartStatus('AI ready — on-device, no cloud');
    updateMotionIndicator();
    return soloCocoModel;
  })().catch(e => {
    soloCocoLoadingPromise = null;
    soloCocoModel = null;
    updateSmartStatus('Failed to load — needs internet on first use');
    showToast('AI model failed to load');
    throw e;
  });
  return soloCocoLoadingPromise;
}

async function runSmartDetect(video) {
  if (!soloCocoModel) return null;
  try {
    const dets = await soloCocoModel.detect(video, 8);
    return dets.filter(d => d.score >= smartConfidence && smartClasses.has(d.class));
  } catch (e) {
    console.warn('Solo smart detect failed:', e);
    return null;
  }
}

function updateSmartStatus(text) {
  const el = document.getElementById('soloSmartStatus');
  if (el) el.textContent = text;
}

// ── Alert banner ───────────────────────────────────────────────
function showAlertBanner(detectedClass) {
  const banner = document.getElementById('soloAlertBanner');
  const zone   = motionZone;
  const cls    = detectedClass
    ? detectedClass.charAt(0).toUpperCase() + detectedClass.slice(1)
    : null;
  banner.textContent = cls
    ? `⚠ ${cls} detected${zone ? ' in zone' : ''}`
    : (zone ? '⚠ Motion in zone' : '⚠ Motion detected');
  banner.classList.add('visible');
}

function hideAlertBanner() {
  document.getElementById('soloAlertBanner').classList.remove('visible');
}

// ── Status bar helpers ─────────────────────────────────────────
function setStatus(badge, text) {
  document.getElementById('soloModeBadge').textContent = badge;
  document.getElementById('soloStatusText').textContent = text;
  const badgeEl = document.getElementById('soloModeBadge');
  if (badge === 'ARMED') {
    badgeEl.style.background = 'rgba(239,68,68,0.85)';
  } else if (badge === 'MOTION!') {
    badgeEl.style.background = 'rgba(239,68,68,0.95)';
  } else {
    badgeEl.style.background = 'rgba(59,130,246,0.85)';
  }
}

function updateMotionIndicator() {
  const ind  = document.getElementById('soloMotionIndicator');
  const text = document.getElementById('soloMotionIndicatorText');
  if (!armed) { ind.classList.remove('show'); return; }
  ind.classList.add('show');
  const ai = smartEnabled && soloCocoModel;
  if (ai && motionZone)  text.textContent = 'AI · ZONE';
  else if (ai)           text.textContent = 'AI WATCHING';
  else if (motionZone)   text.textContent = 'WATCHING ZONE';
  else                   text.textContent = 'WATCHING';
}

// ── Snapshot capture (shared by native alert + ntfy) ───────────
function captureMotionSnap() {
  try {
    const video = document.getElementById('soloVideo');
    if (video && video.videoWidth > 0) {
      const cvs = document.createElement('canvas');
      cvs.width  = 320;
      cvs.height = Math.round(320 * video.videoHeight / video.videoWidth);
      cvs.getContext('2d').drawImage(video, 0, 0, cvs.width, cvs.height);
      return cvs.toDataURL('image/jpeg', 0.6);
    }
  } catch (_) {}
  return '';
}

// ── Native Android notification ────────────────────────────────
function fireNativeAlert(detectedClass) {
  if (!window.AndroidBridge?.fireMotionAlert) return;
  const name = detectedClass
    ? detectedClass.charAt(0).toUpperCase() + detectedClass.slice(1) + ' detected'
    : 'Motion detected';
  window.AndroidBridge.fireMotionAlert('CamNet Solo — ' + name, captureMotionSnap(), true, true);
}

// ── Stealth / incognito mode ───────────────────────────────────
let soloStealthTapCount = 0;
let soloStealthTapTimer = null;

document.getElementById('soloStealthBtn').addEventListener('click', enterSoloStealth);

async function enterSoloStealth() {
  document.getElementById('soloStealthOverlay').style.display = 'block';
  if (!wakeLock) await requestWakeLock();
}

function exitSoloStealth() {
  soloStealthTapCount = 0;
  clearTimeout(soloStealthTapTimer);
  document.getElementById('soloStealthOverlay').style.display = 'none';
}

document.getElementById('soloStealthOverlay').addEventListener('click', () => {
  soloStealthTapCount++;
  clearTimeout(soloStealthTapTimer);
  const hint = document.getElementById('soloStealthHint');
  hint.style.color = '#444';
  setTimeout(() => { hint.style.color = '#111'; }, 300);
  if (soloStealthTapCount >= 3) {
    exitSoloStealth();
  } else {
    soloStealthTapTimer = setTimeout(() => { soloStealthTapCount = 0; }, 2000);
  }
});

// ── Flash / torch ──────────────────────────────────────────────
function triggerMotionFlash() {
  stopFlash();
  const track = localStream?.getVideoTracks()[0];
  if (!track || facingMode === 'user') return;

  if (motionFlashMode === 'steady') {
    setTorch(true);
  } else if (motionFlashMode === 'slow') {
    // 1 Hz — 500ms on, 500ms off
    let on = true;
    setTorch(true);
    flashStrobeTimer = setInterval(() => {
      on = !on;
      setTorch(on);
    }, 500);
  } else if (motionFlashMode === 'fast') {
    // 10 Hz — 50ms on, 50ms off
    let on = true;
    setTorch(true);
    flashStrobeTimer = setInterval(() => {
      on = !on;
      setTorch(on);
    }, 50);
  }

  if (motionFlashDur > 0) {
    flashOffTimer = setTimeout(stopFlash, motionFlashDur * 1000);
  }
}

function stopFlash() {
  clearInterval(flashStrobeTimer); flashStrobeTimer = null;
  clearTimeout(flashOffTimer);     flashOffTimer    = null;
  if (flashTorchOn) setTorch(false);
}

async function setTorch(on) {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    flashTorchOn = on;
  } catch {}
}

// Manual flash mode button — cycles through modes
document.getElementById('soloFlashModeBtn').addEventListener('click', () => {
  const modes = ['off', 'steady', 'slow', 'fast'];
  const idx   = modes.indexOf(flashMode);
  flashMode   = modes[(idx + 1) % modes.length];
  lsSave('flashMode', flashMode);
  updateFlashModeBtn();
  if (flashTorchOn) stopFlash(); // turn off if mode changed while active
});

function updateFlashModeBtn() {
  const icons  = { off: '🔦', steady: '💡', slow: '🔆', fast: '⚡' };
  const labels = { off: 'Off', steady: 'Steady', slow: 'Slow', fast: 'Fast' };
  const btn    = document.getElementById('soloFlashModeBtn');
  btn.querySelector('.ctrl-icon').textContent = icons[flashMode];
  document.getElementById('soloFlashModeLabel').textContent = labels[flashMode];
  btn.classList.toggle('active', flashMode !== 'off');
}

// ── Audio alarm (Web Audio API — no files, works offline) ──────
function ensureAlarmCtx() {
  if (!alarmCtx) {
    alarmCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (alarmCtx.state === 'suspended') alarmCtx.resume().catch(() => {});
}

function triggerAlarm() {
  stopAlarm();
  if (alarmMode === 'off') return;
  ensureAlarmCtx();

  alarmGain = alarmCtx.createGain();
  alarmGain.gain.value = 0.6;
  alarmGain.connect(alarmCtx.destination);

  if (alarmMode === 'beep') {
    // Short 0.5s beeps every 1.5s — stop after cooldownSecs
    let count = 0;
    const maxBeeps = Math.max(3, Math.floor(cooldownSecs / 1.5));
    function beep() {
      if (count++ >= maxBeeps || alarmMode === 'off') { stopAlarm(); return; }
      const osc = alarmCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 880;
      osc.connect(alarmGain);
      osc.start();
      osc.stop(alarmCtx.currentTime + 0.5);
      alarmNode = osc;
      setTimeout(beep, 1500);
    }
    beep();
  } else if (alarmMode === 'tone') {
    const osc = alarmCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 440;
    osc.connect(alarmGain);
    osc.start();
    alarmNode = osc;
    // Auto-stop after cooldownSecs
    if (cooldownSecs > 0) {
      setTimeout(stopAlarm, cooldownSecs * 1000);
    }
  }
}

function stopAlarm() {
  try { alarmNode?.stop(); } catch {}
  alarmNode = null;
  try { alarmGain?.disconnect(); } catch {}
  alarmGain = null;
}

// Alarm mode button
document.getElementById('soloAlarmBtn').addEventListener('click', () => {
  const modes  = ['off', 'beep', 'tone'];
  const idx    = modes.indexOf(alarmMode);
  alarmMode    = modes[(idx + 1) % modes.length];
  lsSave('alarmMode', alarmMode);
  updateAlarmBtn();
  if (alarmMode !== 'off' && armed) triggerAlarm(); // preview
});

function updateAlarmBtn() {
  const icons  = { off: '🔔', beep: '🔉', tone: '🔊' };
  const labels = { off: 'Silent', beep: 'Beep', tone: 'Loud' };
  const btn = document.getElementById('soloAlarmBtn');
  btn.querySelector('.ctrl-icon').textContent = icons[alarmMode];
  document.getElementById('soloAlarmLabel').textContent = labels[alarmMode];
  btn.classList.toggle('active', alarmMode !== 'off');
}

// ── Snapshot ───────────────────────────────────────────────────
document.getElementById('soloSnapBtn').addEventListener('click', takeSnapshot);

function takeSnapshot() {
  const video = document.getElementById('soloVideo');
  if (!video || !video.videoWidth) { showToast('No video — start camera first'); return; }
  const w = video.videoWidth, h = video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (video.classList.contains('mirror')) {
    ctx.translate(w, 0); ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);
  const filename = 'CamNet_Solo_' + new Date().toISOString().replace(/[:.]/g,'-').slice(0,19) + '.jpg';
  const dataUrl  = canvas.toDataURL('image/jpeg', 0.92);

  // Shutter flash
  const flash = document.createElement('div');
  flash.style.cssText = 'position:absolute;inset:0;background:#fff;opacity:0.75;pointer-events:none;z-index:30;transition:opacity 0.35s ease-out';
  document.getElementById('soloPreview').appendChild(flash);
  requestAnimationFrame(() => requestAnimationFrame(() => flash.style.opacity = '0'));
  setTimeout(() => flash.remove(), 400);

  if (window.AndroidBridge?.saveSnapshot) {
    window.AndroidBridge.saveSnapshot(dataUrl, filename);
  } else {
    Object.assign(document.createElement('a'), { href: dataUrl, download: filename }).click();
  }
}

// ── Recording ──────────────────────────────────────────────────
document.getElementById('soloRecordBtn').addEventListener('click', () => {
  if (recordActive) {
    stopRecordingIfActive();
  } else {
    startRecording();
  }
});

function startRecording() {
  if (recordActive || !localStream) return;
  const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  recordActive  = true;
  recordSegNum  = 0;
  recordBaseName = 'CamNet_Solo_' + ts;
  recordChunks  = [];
  _startSegment(mimeType);
  showToast('Recording started');
  updateRecordBtn();
}

function _startSegment(mimeType) {
  if (!recordActive || !localStream) return;
  recordChunks = [];
  try {
    const rec = new MediaRecorder(localStream, mimeType ? { mimeType } : {});
    recorder = rec;
    rec.ondataavailable = e => { if (e.data.size > 0) recordChunks.push(e.data); };
    rec.onstop = () => {
      if (recordChunks.length > 0) {
        const blob    = new Blob(recordChunks, { type: rec.mimeType });
        const ext     = rec.mimeType.includes('mp4') ? 'mp4' : 'webm';
        const segNum  = recordSegNum++;
        const suffix  = `_part${String(segNum + 1).padStart(2, '0')}`;
        _saveSegment(blob, `${recordBaseName}${suffix}.${ext}`);
      }
      recordChunks = [];
      recorder     = null;
      updateRecordBtn();
      if (recordActive) _startSegment(mimeType);
    };
    rec.start();
    recordSegTimer = setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop();
    }, SEG_MS);
  } catch (e) {
    recordActive = false;
    recorder     = null;
    showToast('Recording not supported on this device');
    updateRecordBtn();
  }
}

function stopRecordingIfActive() {
  if (!recordActive) return;
  recordActive = false;
  clearTimeout(recordSegTimer); recordSegTimer = null;
  clearTimeout(recordIdleTimer); recordIdleTimer = null;
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  } else {
    recorder = null;
    updateRecordBtn();
  }
}

function _saveSegment(blob, filename) {
  if (window.AndroidBridge?.saveVideo) {
    const reader = new FileReader();
    reader.onloadend = () => window.AndroidBridge.saveVideo(reader.result, filename);
    reader.readAsDataURL(blob);
  } else {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    showToast('Video downloaded');
  }
}

function updateRecordBtn() {
  const btn = document.getElementById('soloRecordBtn');
  btn.classList.toggle('recording', recordActive);
  btn.querySelector('.ctrl-icon').textContent = recordActive ? '⏹' : '🎬';
  btn.querySelector('span').textContent       = recordActive ? 'Stop' : 'Record';
  document.getElementById('soloRecIndicator').classList.toggle('show', recordActive);
}

// ── Flip camera ────────────────────────────────────────────────
document.getElementById('soloFlipBtn').addEventListener('click', flipCamera);

async function flipCamera() {
  if (mediaBusy) return;
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  document.getElementById('soloVideo').classList.toggle('mirror', facingMode === 'user');
  stopFlash();
  await initMedia();
}

// ── Wake lock ──────────────────────────────────────────────────
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) {
    console.warn('Wake lock failed:', e);
  }
}

// ── Zone editor ────────────────────────────────────────────────
document.getElementById('soloZoneBtn').addEventListener('click', openZoneEditor);

function openZoneEditor() {
  const preview = document.getElementById('soloPreview');
  if (preview.querySelector('.solo-zone-editor')) return;

  const editor = document.createElement('div');
  editor.className = 'solo-zone-editor';

  const backdrop = document.createElement('div');
  backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.45);pointer-events:none';
  editor.appendChild(backdrop);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none';
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  editor.appendChild(svg);

  const hint = document.createElement('div');
  hint.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.75);color:#f1f5f9;font-size:12px;font-weight:600;padding:5px 12px;border-radius:20px;pointer-events:none;white-space:nowrap;z-index:1;text-align:center;max-width:90%';
  editor.appendChild(hint);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'position:absolute;bottom:10px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:1';

  const btnStyle = 'padding:8px 16px;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent';
  const undoBtn  = document.createElement('button');
  undoBtn.textContent = 'Undo'; undoBtn.style.cssText = btnStyle + ';background:#334155;color:#f1f5f9';
  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear'; clearBtn.style.cssText = btnStyle + ';background:#334155;color:#f1f5f9';
  const saveBtn  = document.createElement('button');
  saveBtn.textContent = 'Save'; saveBtn.style.cssText = btnStyle + ';background:#3b82f6;color:#fff';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel'; cancelBtn.style.cssText = btnStyle + ';background:#475569;color:#f1f5f9';

  btnRow.appendChild(undoBtn);
  btnRow.appendChild(clearBtn);
  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);
  editor.appendChild(btnRow);
  preview.appendChild(editor);

  // Load existing polygon
  let points = (motionZone?.type === 'polygon' && motionZone.points?.length >= 3)
    ? motionZone.points.map(p => ({ x: p.x * 100, y: p.y * 100 })) // convert to svg 0-100
    : [];
  let closed = points.length >= 3;

  function distPx(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

  function redraw() {
    svg.innerHTML = '';
    if (points.length === 0) { hint.textContent = 'Tap to add vertices'; return; }

    if (closed) {
      hint.textContent = 'Tap Save to confirm or drag a vertex to adjust';
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', points.map(p => `${p.x},${p.y}`).join(' '));
      poly.setAttribute('fill', 'rgba(59,130,246,0.25)');
      poly.setAttribute('stroke', '#3b82f6');
      poly.setAttribute('stroke-width', '1.5');
      svg.appendChild(poly);
    } else {
      hint.textContent = points.length < 3
        ? 'Tap to add vertices (3+ to close)'
        : 'Tap near ① to close polygon';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      path.setAttribute('points', points.map(p => `${p.x},${p.y}`).join(' '));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#3b82f6');
      path.setAttribute('stroke-width', '1.5');
      svg.appendChild(path);
      // Dashed guide line back to start
      if (points.length >= 2) {
        const guide = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        guide.setAttribute('x1', points[points.length - 1].x);
        guide.setAttribute('y1', points[points.length - 1].y);
        guide.setAttribute('x2', points[0].x);
        guide.setAttribute('y2', points[0].y);
        guide.setAttribute('stroke', 'rgba(59,130,246,0.45)');
        guide.setAttribute('stroke-width', '1');
        guide.setAttribute('stroke-dasharray', '3 3');
        svg.appendChild(guide);
      }
    }

    // Vertex dots
    points.forEach((p, idx) => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', p.x); circle.setAttribute('cy', p.y); circle.setAttribute('r', '2.5');
      circle.setAttribute('fill', idx === 0 ? '#f59e0b' : '#3b82f6');
      circle.setAttribute('stroke', '#fff'); circle.setAttribute('stroke-width', '0.8');
      svg.appendChild(circle);
      if (idx === 0) {
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', p.x + 3); label.setAttribute('y', p.y - 3);
        label.setAttribute('fill', '#f59e0b'); label.setAttribute('font-size', '6');
        label.setAttribute('font-weight', 'bold');
        label.textContent = '①';
        svg.appendChild(label);
      }
    });
  }
  redraw();

  // Convert pointer event coords to SVG 0-100 space
  function toSvgCoords(e) {
    const rect = editor.getBoundingClientRect();
    const touch = e.touches?.[0] ?? e;
    return {
      x: ((touch.clientX - rect.left) / rect.width)  * 100,
      y: ((touch.clientY - rect.top)  / rect.height) * 100,
    };
  }

  editor.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (closed) return;
    const { x, y } = toSvgCoords(e);
    // Close if near first vertex (3+ points already)
    if (points.length >= 3 && distPx(x, y, points[0].x, points[0].y) < 8) {
      closed = true;
      redraw();
      return;
    }
    points.push({ x, y });
    redraw();
  });

  undoBtn.addEventListener('click', () => {
    if (closed) { closed = false; } else { points.pop(); }
    redraw();
  });
  clearBtn.addEventListener('click', () => {
    points = []; closed = false; redraw();
  });
  saveBtn.addEventListener('click', () => {
    if (closed && points.length >= 3) {
      motionZone = { type: 'polygon', points: points.map(p => ({ x: p.x / 100, y: p.y / 100 })) };
    } else {
      motionZone = null;
    }
    lsSave('zone', motionZone);
    editor.remove();
    updateMotionIndicator();
    showToast(motionZone ? 'Zone saved' : 'Zone cleared');
    // Close settings panel
    document.getElementById('soloSettingsPanel').classList.add('hidden');
  });
  cancelBtn.addEventListener('click', () => editor.remove());
}

// ── Settings panel wiring ──────────────────────────────────────
document.getElementById('soloSettingsBtn').addEventListener('click', () => {
  syncSettingsPanel();
  openPanel('soloSettingsPanel');
});

document.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', () => closePanel(el.dataset.close));
});

function openPanel(id)  { document.getElementById(id).classList.remove('hidden'); }
function closePanel(id) { document.getElementById(id).classList.add('hidden'); }

function syncSettingsPanel() {
  // Sensitivity
  document.querySelectorAll('#soloSensSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sens === sens));
  // Consecutive
  document.querySelectorAll('#soloConsecSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.consec, 10) === consec));
  // Cooldown
  document.querySelectorAll('#soloCooldownSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.secs, 10) === cooldownSecs));
  // Smart toggle + rows
  document.getElementById('soloSmartToggle').classList.toggle('on', smartEnabled);
  document.getElementById('soloSmartStatusRow').style.display = smartEnabled ? '' : 'none';
  document.getElementById('soloConfidenceRow').style.display  = smartEnabled ? '' : 'none';
  document.getElementById('soloClassesRow').style.display     = smartEnabled ? '' : 'none';
  // Confidence slider
  const slid = document.getElementById('soloConfidenceSlider');
  slid.value = Math.round(smartConfidence * 100);
  document.getElementById('soloConfidenceVal').textContent = slid.value + '%';
  // Classes checkboxes
  buildClassesUI();
  // Motion flash mode
  document.querySelectorAll('#soloMotionFlashModeSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.fmode === motionFlashMode));
  // Flash duration
  document.querySelectorAll('#soloFlashDurSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.fdur, 10) === motionFlashDur));
  // Alarm mode
  document.querySelectorAll('#soloAlarmModeSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.alarm === alarmMode));
  // Record on motion
  document.getElementById('soloRecordOnMotionToggle').classList.toggle('on', recordOnMotion);
  document.getElementById('soloRecordIdleRow').style.display = recordOnMotion ? '' : 'none';
  document.querySelectorAll('#soloRecordIdleSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.idle, 10) === recordIdleSecs));
  // ntfy URL
  document.getElementById('soloNtfyUrl').value = ntfyUrl;
}

function buildClassesUI() {
  const container = document.getElementById('soloClassesContainer');
  container.innerHTML = '';
  for (const opt of SMART_CLASS_OPTIONS) {
    const chip = document.createElement('button');
    const on   = smartClasses.has(opt.value);
    chip.textContent  = opt.label;
    chip.dataset.class = opt.value;
    chip.style.cssText = `padding:6px 12px;border:1.5px solid ${on ? '#3b82f6' : '#334155'};border-radius:18px;` +
      `background:${on ? 'rgba(59,130,246,0.15)' : 'transparent'};color:${on ? '#60a5fa' : '#94a3b8'};` +
      `font-size:12px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent`;
    chip.addEventListener('click', () => {
      if (smartClasses.has(opt.value)) {
        if (smartClasses.size > 1) smartClasses.delete(opt.value);
      } else {
        smartClasses.add(opt.value);
      }
      lsSave('smartClasses', [...smartClasses]);
      buildClassesUI(); // re-render
    });
    container.appendChild(chip);
  }
}

// ── Settings panel control bindings ───────────────────────────
document.getElementById('soloSensSeg').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  sens = b.dataset.sens;
  lsSave('sens', sens);
  document.querySelectorAll('#soloSensSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
});

document.getElementById('soloConsecSeg').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  consec = parseInt(b.dataset.consec, 10);
  lsSave('consec', consec);
  document.querySelectorAll('#soloConsecSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
});

document.getElementById('soloCooldownSeg').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  cooldownSecs = parseInt(b.dataset.secs, 10);
  lsSave('cooldown', cooldownSecs);
  document.querySelectorAll('#soloCooldownSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
});

document.getElementById('soloSmartToggle').addEventListener('click', async () => {
  smartEnabled = !smartEnabled;
  lsSave('smartEnabled', smartEnabled);
  document.getElementById('soloSmartToggle').classList.toggle('on', smartEnabled);
  document.getElementById('soloSmartStatusRow').style.display = smartEnabled ? '' : 'none';
  document.getElementById('soloConfidenceRow').style.display  = smartEnabled ? '' : 'none';
  document.getElementById('soloClassesRow').style.display     = smartEnabled ? '' : 'none';
  updateMotionIndicator();
  if (smartEnabled && !soloCocoModel) {
    try { await loadCocoModel(); } catch {}
  }
});

document.getElementById('soloConfidenceSlider').addEventListener('input', e => {
  smartConfidence = parseInt(e.target.value, 10) / 100;
  lsSave('smartConfidence', smartConfidence);
  document.getElementById('soloConfidenceVal').textContent = e.target.value + '%';
});

document.getElementById('soloMotionFlashModeSeg').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  motionFlashMode = b.dataset.fmode;
  lsSave('motionFlashMode', motionFlashMode);
  document.querySelectorAll('#soloMotionFlashModeSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
});

document.getElementById('soloFlashDurSeg').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  motionFlashDur = parseInt(b.dataset.fdur, 10);
  lsSave('motionFlashDur', motionFlashDur);
  document.querySelectorAll('#soloFlashDurSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
});

document.getElementById('soloAlarmModeSeg').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  alarmMode = b.dataset.alarm;
  lsSave('alarmMode', alarmMode);
  document.querySelectorAll('#soloAlarmModeSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
  updateAlarmBtn();
});

document.getElementById('soloRecordOnMotionToggle').addEventListener('click', () => {
  recordOnMotion = !recordOnMotion;
  lsSave('recordOnMotion', recordOnMotion);
  document.getElementById('soloRecordOnMotionToggle').classList.toggle('on', recordOnMotion);
  document.getElementById('soloRecordIdleRow').style.display = recordOnMotion ? '' : 'none';
});

document.getElementById('soloRecordIdleSeg').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  recordIdleSecs = parseInt(b.dataset.idle, 10);
  lsSave('recordIdleSecs', recordIdleSecs);
  document.querySelectorAll('#soloRecordIdleSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
});

document.getElementById('soloNtfyUrl').addEventListener('change', e => {
  ntfyUrl = e.target.value.trim();
  lsSave('ntfyUrl', ntfyUrl);
});

document.getElementById('soloTestNotifBtn').addEventListener('click', () => {
  const url = document.getElementById('soloNtfyUrl').value.trim();
  if (!url) { showToast('Enter a ntfy topic URL first'); return; }
  lsSave('ntfyUrl', url);
  ntfyUrl = url;
  if (window.AndroidBridge?.sendWebhookNotification) {
    window.AndroidBridge.sendWebhookNotification(
      url,
      'CamNet Solo — Test notification',
      'Test from CamNet Solo at ' + new Date().toLocaleTimeString(),
      ''
    );
    showToast('Test notification sent');
  } else {
    showToast('sendWebhookNotification not available in browser');
  }
});

// ── Home button ────────────────────────────────────────────────
document.getElementById('soloHomeBtn').addEventListener('click', () => {
  if (armed) setArmed(false);
  stopRecordingIfActive();
  stopFlash();
  stopAlarm();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (window.AndroidBridge?.goHome) {
    window.AndroidBridge.goHome();
  } else {
    location.href = '/';
  }
});

// ── Restore UI state from persisted values ─────────────────────
function restoreUI() {
  updateFlashModeBtn();
  updateAlarmBtn();
  updateRecordBtn();
}

// ── Visibility change — keep stream alive ──────────────────────
document.addEventListener('visibilitychange', async () => {
  if (!localStream || document.visibilityState !== 'visible') return;
  const vTrack = localStream.getVideoTracks()[0];
  if (vTrack && vTrack.readyState === 'ended') {
    await initMedia().catch(() => {});
  }
});

// ── Toast ──────────────────────────────────────────────────────
function showToast(msg) {
  let t = document.getElementById('_solo_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '_solo_toast';
    t.style.cssText = 'position:fixed;bottom:160px;left:50%;transform:translateX(-50%);background:rgba(255,255,255,0.12);backdrop-filter:blur(10px);color:#fff;padding:10px 20px;border-radius:30px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none;transition:opacity 0.3s';
    document.body.appendChild(t);
  }
  t.textContent   = msg;
  t.style.opacity = '1';
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.style.opacity = '0', 2500);
}
