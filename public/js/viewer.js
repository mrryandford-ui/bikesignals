'use strict';

// LAN-first: host candidates are sufficient for same-subnet WebRTC.
// Camera drives STUN fallback via createPeer() retry; viewer just handles new offers.
const ICE_SERVERS = [];

// ── State ──────────────────────────────────────────────────────
let ws = null;
let roomId = null;
let joinURL = null; // full URL camera phones should open (uses LAN IP, not localhost)
const peers = new Map(); // cameraId → { pc, name, stream, recorder, motion, ... }
let cameraCounter = 0;

let globalMotion = true;
let motionSens = 'mid';
let muteAll = false;
let mirrorFront = true;
let currentLayout = 'l-auto';
let photoQuality = '720'; // '480' | '720' | '1080' | 'source'

// ── Rough JPEG + video size tables for picker estimates ────────
// Values are byte/bit averages — JPEG size varies a lot with scene content.
const JPEG_BYTES_AT_RES = { 240: 25_000, 480: 75_000, 720: 200_000, 1080: 425_000 };
const VIDEO_BPS_AT_RES  = { 240: 300_000, 480: 800_000, 720: 1_500_000, 1080: 3_000_000 };
const JPEG_Q = 0.92;

// Map a photoQuality choice to an effective capture resolution height.
function resolvePhotoRes(choice, sourceH) {
  if (choice === 'source' || !choice) return sourceH;
  const target = parseInt(choice, 10);
  return Math.min(target, sourceH); // never upscale
}

// Estimate JPEG bytes at a given height (round to nearest preset bucket).
function estimateJpegBytes(h) {
  const buckets = [240, 480, 720, 1080];
  const r = buckets.find(b => b >= h) || 1080;
  return JPEG_BYTES_AT_RES[r];
}

// Capture a JPEG blob from a card's video element, scaled to maxH.
async function captureVideoFrameJpeg(video, maxH, jpegQ) {
  if (!video || !video.videoWidth) return null;
  const srcW = video.videoWidth, srcH = video.videoHeight;
  const h = Math.min(maxH || srcH, srcH);
  const w = Math.round(srcW * h / srcH);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return await new Promise(r => canvas.toBlob(r, 'image/jpeg', jpegQ ?? JPEG_Q));
}

function formatBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDurationMs(ms) {
  if (ms >= 3600_000) {
    const h = ms / 3600_000;
    return Number.isInteger(h) ? `${h} hr` : `${h.toFixed(1)} hr`;
  }
  if (ms >= 60_000) {
    const m = ms / 60_000;
    return Number.isInteger(m) ? `${m} min` : `${m.toFixed(1)} min`;
  }
  return `${Math.round(ms / 1000)} sec`;
}

// ── Motion detection sensitivity thresholds ────────────────────
const SENS = {
  low:  { pixelDiff: 30, fraction: 0.02  }, // large changes only, filters compression noise
  mid:  { pixelDiff: 20, fraction: 0.01  },
  high: { pixelDiff: 15, fraction: 0.005 },
};
const MOTION_COOLDOWN_MS      = 8_000; // min ms between alerts per camera
const MOTION_CONSECUTIVE_REQ  = 3;     // frames above threshold required before alert fires

// ── AI smart detection (COCO-SSD via TensorFlow.js, on-device) ─
let smartDetectionEnabled = false;
let smartClasses          = new Set(['person']);
let cocoModel             = null;
let cocoLoadingPromise    = null;
const SMART_DETECTION_COOLDOWN_MS = 3_000; // min ms between AI inferences per camera
const SMART_SCORE_THRESHOLD       = 0.45;  // confidence floor

const SMART_CLASS_OPTIONS = [
  { value: 'person',     label: '🚶 Person',    defaultOn: true },
  { value: 'car',        label: '🚗 Car' },
  { value: 'motorcycle', label: '🏍 Motorcycle' },
  { value: 'bicycle',    label: '🚲 Bicycle' },
  { value: 'truck',      label: '🚛 Truck' },
  { value: 'bus',        label: '🚌 Bus' },
  { value: 'dog',        label: '🐕 Dog' },
  { value: 'cat',        label: '🐈 Cat' },
];

// ── Settings persistence ───────────────────────────────────────
const LS = 'camnet.viewer.';
function lsSave(key, val) {
  try { localStorage.setItem(LS + key, JSON.stringify(val)); } catch {}
}
function lsLoad(key, fallback) {
  try {
    const raw = localStorage.getItem(LS + key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

// Rehydrate before any UI renders
globalMotion          = lsLoad('globalMotion', true);
motionSens            = lsLoad('motionSens', 'mid');
muteAll               = lsLoad('muteAll', false);
mirrorFront           = lsLoad('mirrorFront', true);
currentLayout         = lsLoad('currentLayout', 'l-auto');
photoQuality          = lsLoad('photoQuality', '720');
smartDetectionEnabled = lsLoad('smartDetectionEnabled', false);
smartClasses          = new Set(lsLoad('smartClasses', ['person']));

function loadScript(src, { integrity, crossOrigin } = {}) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src   = src;
    s.async = true;
    if (crossOrigin) s.crossOrigin = crossOrigin;
    if (integrity)   s.integrity   = integrity;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function loadCocoModel() {
  if (cocoModel) return cocoModel;
  if (cocoLoadingPromise) return cocoLoadingPromise;
  cocoLoadingPromise = (async () => {
    updateSmartStatus('Loading TensorFlow…');
    if (!window.tf) {
      // integrity hash: run `openssl dgst -sha384 -binary tf.min.js | openssl base64 -A` to compute
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.21.0/dist/tf.min.js',
        { crossOrigin: 'anonymous' });
    }
    updateSmartStatus('Loading detection model…');
    if (!window.cocoSsd) {
      // integrity hash: run `openssl dgst -sha384 -binary coco-ssd.min.js | openssl base64 -A` to compute
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js',
        { crossOrigin: 'anonymous' });
    }
    updateSmartStatus('Warming up…');
    cocoModel = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
    updateSmartStatus('AI ready — on-device, no cloud');
    return cocoModel;
  })().catch(e => {
    cocoLoadingPromise = null;
    cocoModel = null;
    updateSmartStatus('Failed to load — needs internet on first use');
    console.warn('COCO-SSD load failed:', e);
    showToast('AI model failed to load — check connection');
    throw e;
  });
  return cocoLoadingPromise;
}

function updateSmartStatus(text) {
  const el = document.getElementById('smartDetectionStatus');
  if (el) el.textContent = text;
}

async function runSmartDetection(video) {
  if (!cocoModel) return null;
  try {
    const detections = await cocoModel.detect(video, 8);
    return detections.filter(d => d.score >= SMART_SCORE_THRESHOLD && smartClasses.has(d.class));
  } catch (e) {
    console.warn('Detection failed:', e);
    return null;
  }
}

// ── WebSocket ──────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    setWsStatus('connected');
    startPing();
    const saved = sessionStorage.getItem('camnet_room');
    ws.send(JSON.stringify(saved
      ? { type: 'rejoin-room', roomId: saved }
      : { type: 'create-room' }
    ));
  };

  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    onMessage(msg);
  };

  ws.onclose = () => {
    stopPing();
    setWsStatus('disconnected');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => ws.close();
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setWsStatus(state) {
  const dot  = document.getElementById('wsStatusDot');
  const text = document.getElementById('wsStatusText');
  dot.className = 'dot ' + state;
  text.textContent = state === 'connected' ? 'Live' : state === 'disconnected' ? 'Reconnecting…' : 'Connecting…';
}

// ── Message handler ────────────────────────────────────────────
async function onMessage(msg) {
  switch (msg.type) {
    case 'room-created':    onRoomCreated(msg.roomId); break;
    case 'room-rejoined':   onRoomCreated(msg.roomId); break; // same UI update
    case 'camera-joined':   onCameraJoined(msg.cameraId, msg.cameraName); break;
    case 'camera-left':     onCameraLeft(msg.cameraId);           break;
    case 'offer':           await handleOffer(msg);               break;
    case 'ice-candidate':   await handleIce(msg);                 break;
    case 'camera-status':   onCameraStatus(msg);                  break;
    case 'pong':            onPong(msg);                          break;
  }
}

// ── Room created ───────────────────────────────────────────────
function onRoomCreated(id) {
  roomId = id;
  sessionStorage.setItem('camnet_room', id);
  const ip      = window._lanIP;
  const sslPort = window._sslPort || 3443;
  const base    = ip ? `https://${ip}:${sslPort}` : location.origin;
  joinURL = `${base}/?room=${id}`;

  document.getElementById('roomCode').textContent = id;
  document.getElementById('panelRoomCode').textContent = id;
  buildQR(joinURL);
  document.getElementById('emptyState').classList.remove('hidden');
}

function buildQR(url) {
  ['qrContainer', 'panelQr'].forEach(elId => {
    const el = document.getElementById(elId);
    el.innerHTML = '';
    new QRCode(el, { text: url, width: 120, height: 120, colorDark: '#000', colorLight: '#fff' });
  });
}

// ── Camera lifecycle ───────────────────────────────────────────
function onCameraJoined(cameraId, name) {
  // Clean up any existing entry for this cameraId.
  // This happens when the viewer's WS reconnects — the server re-announces all
  // cameras still in the room, so we get camera-joined for IDs already in our map.
  const existing = peers.get(cameraId);
  if (existing) {
    stopMotion(cameraId);
    stopTimelapse(cameraId);
    clearTimeout(existing.motionFlashTimer);
    existing.pc.close();
    document.getElementById(`card-${cameraId}`)?.remove();
    peers.delete(cameraId);
  }

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Prepare to receive video+audio
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = (e) => {
    const peer = peers.get(cameraId);
    if (!peer) return;
    if (!peer.stream) peer.stream = e.streams[0];
    else e.streams[0].getTracks().forEach(t => peer.stream.addTrack(t));
    attachStream(cameraId, peer.stream);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'ice-candidate', cameraId, candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => updateConnState(cameraId, pc.connectionState);
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') pc.restartIce();
  };

  peers.set(cameraId, { pc, name, stream: null, recorder: null, motion: null, facingMode: null, torchOn: false, quality: 720, stealth: false, recordTarget: null, recDurationMs: 0, recStartTime: 0, recSegNum: 0, recBaseName: '', recChunks: [], recSegTimer: null, recDurationTimer: null, zone: null, lastMotionAt: 0, motionConsecutive: 0, motionFlashActive: false, motionFlashTimer: null, timelapse: null });
  addCameraCard(cameraId, name);
  updateCamCount();
}

function onCameraLeft(cameraId) {
  const peer = peers.get(cameraId);
  if (peer) {
    stopMotion(cameraId);
    stopRecording(cameraId);
    stopTimelapse(cameraId);
    clearTimeout(peer.motionFlashTimer);
    peer.pc.close();
    peers.delete(cameraId);
  }
  document.getElementById(`card-${cameraId}`)?.remove();
  updateCamCount();
  toggleEmptyState();
}

function updateCamCount() {
  const n = peers.size;
  document.getElementById('camCountBadge').textContent = `${n} camera${n !== 1 ? 's' : ''}`;
}

function toggleEmptyState() {
  const empty = peers.size === 0;
  document.getElementById('emptyState').classList.toggle('hidden', !empty);
  document.getElementById('feedGrid').classList.toggle('hidden', empty);
}

// ── WebRTC signaling ───────────────────────────────────────────
async function handleOffer({ cameraId, sdp }) {
  if (!peers.has(cameraId)) onCameraJoined(cameraId, `Camera ${++cameraCounter}`);
  const peer = peers.get(cameraId);
  // If the pc is not in a state that can accept an offer, recreate it cleanly.
  if (peer.pc.signalingState !== 'stable' && peer.pc.signalingState !== 'have-remote-offer') {
    onCameraJoined(cameraId, peer.name); // closes old pc, recreates fresh
  }
  const p = peers.get(cameraId);
  try {
    await p.pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await p.pc.createAnswer();
    await p.pc.setLocalDescription(answer);
    wsSend({ type: 'answer', cameraId, sdp: answer.sdp });
  } catch (e) {
    console.warn('handleOffer failed, retrying with fresh peer:', e);
    try {
      onCameraJoined(cameraId, p.name);
      const fresh = peers.get(cameraId);
      await fresh.pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await fresh.pc.createAnswer();
      await fresh.pc.setLocalDescription(answer);
      wsSend({ type: 'answer', cameraId, sdp: answer.sdp });
    } catch (e2) {
      console.error('handleOffer retry also failed:', e2);
      showToast('Camera reconnect failed');
    }
  }
}

async function handleIce({ cameraId, candidate }) {
  const peer = peers.get(cameraId);
  if (!peer || !candidate) return;
  try { await peer.pc.addIceCandidate(candidate); } catch {}
}

function updateConnState(cameraId, state) {
  const dot = document.querySelector(`#card-${cameraId} .dot`);
  if (!dot) return;
  dot.className = 'dot ' + (
    state === 'connected'  ? 'connected' :
    state === 'failed' || state === 'disconnected' ? 'disconnected' : 'connecting'
  );
  const overlay = document.querySelector(`#card-${cameraId} .cam-connecting`);
  if (overlay) overlay.classList.toggle('hidden', state === 'connected');
}

function onCameraStatus({ cameraId, facingMode, muted, torch, quality: q, stealth }) {
  const peer = peers.get(cameraId);
  if (!peer) return;

  if (facingMode !== undefined) {
    peer.facingMode = facingMode;
    applyMirror(cameraId);
    const flashBtn = document.querySelector(`#card-${cameraId} [data-action="flash"]`);
    if (flashBtn) {
      const isFront = facingMode === 'user';
      flashBtn.disabled = isFront;
      flashBtn.style.opacity = isFront ? '0.3' : '';
      flashBtn.title = isFront ? 'Flash unavailable on front camera' : 'Toggle flash';
      if (isFront && peer.torchOn) {
        peer.torchOn = false;
        flashBtn.classList.remove('active');
      }
    }
  }
  if (muted !== undefined) {
    const btn = document.querySelector(`#card-${cameraId} [data-action="mute"]`);
    if (btn) { btn.title = muted ? 'Unmute' : 'Mute'; btn.textContent = muted ? '🔇' : '🔊'; btn.classList.toggle('active', muted); }
  }
  if (torch !== undefined) {
    peer.torchOn = torch;
    const btn = document.querySelector(`#card-${cameraId} [data-action="flash"]`);
    if (btn) btn.classList.toggle('active', torch);
  }
  if (q !== undefined) {
    peer.quality = q;
    const btn = document.querySelector(`#card-${cameraId} [data-action="quality"]`);
    if (btn) btn.title = `Quality: ${q}p`;
  }
  if (stealth !== undefined) {
    peer.stealth = stealth;
    const btn = document.querySelector(`#card-${cameraId} [data-action="stealth"]`);
    if (btn) btn.classList.toggle('active', stealth);
  }
}

function onPong({ ts }) {
  const latency = Date.now() - ts;
  document.querySelectorAll('.latency-badge').forEach(el => {
    el.textContent = `${latency}ms`;
  });
}

// ── Stream attachment ──────────────────────────────────────────
function syncMuteBtn(cameraId) {
  const video = document.querySelector(`#card-${cameraId} .cam-video`);
  const btn   = document.querySelector(`#card-${cameraId} [data-action="mute"]`);
  if (!video || !btn) return;
  btn.textContent = video.muted ? '🔇' : '🔊';
  btn.title       = video.muted ? 'Unmute' : 'Mute';
  btn.classList.toggle('active', video.muted);
}

function attachStream(cameraId, stream) {
  const video = document.querySelector(`#card-${cameraId} .cam-video`);
  if (!video) return;
  video.srcObject = stream;
  video.muted = muteAll;
  video.play()
    .catch(() => { video.muted = true; return video.play().catch(() => {}); })
    .finally(() => syncMuteBtn(cameraId));
  applyMirror(cameraId);
  startMotion(cameraId);
}

function applyMirror(cameraId) {
  const peer = peers.get(cameraId);
  const video = document.querySelector(`#card-${cameraId} .cam-video`);
  if (!video || !peer) return;
  const shouldMirror = mirrorFront && peer.facingMode === 'user';
  video.classList.toggle('mirror', shouldMirror);
}

// ── Camera card DOM ────────────────────────────────────────────
function addCameraCard(cameraId, name) {
  const grid = document.getElementById('feedGrid');
  const card = document.createElement('div');
  card.className = 'cam-card';
  card.id = `card-${cameraId}`;

  card.innerHTML = `
    <video class="cam-video" autoplay playsinline muted></video>
    <div class="cam-connecting">
      <div class="spinner"></div>
      <span>Connecting…</span>
    </div>
    <div class="cam-top-bar">
      <span class="dot connecting"></span>
      <span class="cam-name" id="name-${cameraId}">${escHtml(name)}</span>
      <span class="latency-badge" style="margin-left:auto">—</span>
      <button class="cam-menu-btn" data-action="menu" title="Show/hide controls" aria-label="Toggle controls">⋯</button>
    </div>
    <div class="cam-controls">
      <button class="icon-btn" data-action="fullscreen"  title="Fullscreen">⛶</button>
      <button class="icon-btn" data-action="snapshot"    title="Snapshot">📸</button>
      <button class="icon-btn" data-action="record"      title="Record">⏺</button>
      <button class="icon-btn" data-action="timelapse"   title="Timelapse">⏱</button>
      <button class="icon-btn" data-action="mute"        title="Mute">🔊</button>
      <button class="icon-btn" data-action="nightvision" title="Night vision">🌙</button>
      <button class="icon-btn" data-action="motion"      title="Motion detection">🎯</button>
      <button class="icon-btn" data-action="zone"        title="Detection zone">🔳</button>
      <button class="icon-btn" data-action="flip"        title="Flip camera (remote)">🔄</button>
      <button class="icon-btn" data-action="flash"       title="Toggle flash (remote)">🔦</button>
      <button class="icon-btn" data-action="stealth"     title="Stealth mode (remote)">🥷</button>
      <button class="icon-btn" data-action="quality"     title="Quality: 720p">🎞️</button>
      <button class="icon-btn" data-action="rename"      title="Rename">✏️</button>
      <button class="icon-btn danger" data-action="disconnect" title="Disconnect">✕</button>
    </div>
  `;

  // Touch: tap to toggle controls visibility on mobile, plus the explicit ⋯ menu button.
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="menu"]')) {
      card.classList.toggle('show-controls');
      e.stopPropagation();
      return;
    }
    if (e.target.closest('button')) return;
    card.classList.toggle('show-controls');
  });

  // Control button actions
  card.querySelector('.cam-controls').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    handleCardAction(cameraId, btn.dataset.action, btn);
  });

  grid.appendChild(card);
  toggleEmptyState();
}

async function handleCardAction(cameraId, action, btn) {
  const peer = peers.get(cameraId);
  const video = document.querySelector(`#card-${cameraId} .cam-video`);
  if (!peer) return;

  switch (action) {
    case 'fullscreen':
      toggleFullscreen(cameraId);
      break;

    case 'snapshot':
      takeSnapshot(cameraId);
      break;

    case 'mute': {
      const muted = !video.muted;
      video.muted = muted;
      if (!muted) video.play().catch(() => {}); // user-gesture re-play to unblock audio
      btn.title = muted ? 'Unmute' : 'Mute';
      btn.textContent = muted ? '🔇' : '🔊';
      btn.classList.toggle('active', muted);
      showToast(muted ? `🔇 ${peer.name} muted` : `🔊 ${peer.name} unmuted`);
      break;
    }

    case 'nightvision': {
      video.classList.toggle('night');
      const on = video.classList.contains('night');
      btn.classList.toggle('active', on);
      showToast(on ? '🌙 Night vision on' : '🌙 Night vision off');
      break;
    }

    case 'motion':
      if (peer.motion) {
        stopMotion(cameraId);
        btn.classList.remove('active');
        showToast('🎯 Motion detection off');
      } else {
        startMotion(cameraId);
        btn.classList.add('active');
        showToast(smartDetectionEnabled ? '🧠 Smart motion detection on' : '🎯 Motion detection on');
      }
      break;

    case 'zone':
      openZoneEditor(cameraId);
      break;

    case 'timelapse':
      if (peer.timelapse) {
        stopTimelapse(cameraId);
        btn.classList.remove('active');
      } else {
        const tlOpts = await showTimelapsePicker(peer.quality);
        if (!tlOpts) break;
        startTimelapse(cameraId, tlOpts);
        btn.classList.add('active');
      }
      break;

    case 'record':
      if (peer.recordTarget) {
        stopRecording(cameraId);
        btn.textContent = '⏺'; btn.classList.remove('active');
      } else {
        const opts = await showRecordingOptionsPicker(peer.quality);
        if (!opts) break;
        await startRecording(cameraId, opts.target, opts.durationMs);
        btn.textContent = '⏹'; btn.classList.add('active');
      }
      break;

    case 'flip':
      wsSend({ type: 'camera-command', cameraId, command: 'flip' });
      btn.style.transform = 'rotate(180deg)';
      setTimeout(() => btn.style.transform = '', 400);
      showToast(`🔄 ${peer.name} — flipping camera`);
      break;

    case 'flash': {
      if (peer.facingMode === 'user') break;
      peer.torchOn = !peer.torchOn;
      wsSend({ type: 'camera-command', cameraId, command: 'torch-toggle' });
      btn.classList.toggle('active', peer.torchOn);
      if (!peer.torchOn) {
        // User manually turned off — cancel any motion-flash auto-off timer
        peer.motionFlashActive = false;
        clearTimeout(peer.motionFlashTimer);
        peer.motionFlashTimer = null;
      }
      showToast(peer.torchOn ? '🔦 Flash on' : '🔦 Flash off');
      break;
    }

    case 'stealth':
      wsSend({ type: 'camera-command', cameraId, command: 'stealth-toggle' });
      showToast(peer.stealth ? `Stealth OFF on ${peer.name}` : `Stealth ON on ${peer.name}`);
      break;

    case 'quality': {
      const quals = [240, 480, 720, 1080];
      const cur = peer.quality || 720;
      const chosen = await showQualityPicker(quals, cur);
      if (chosen === null) break;
      peer.quality = chosen;
      wsSend({ type: 'camera-command', cameraId, command: 'quality', value: chosen });
      btn.title = `Quality: ${chosen}p`;
      showToast(`${peer.name} → ${chosen}p`);
      break;
    }

    case 'rename':
      openRename(cameraId);
      break;

    case 'disconnect':
      wsSend({ type: 'camera-command', cameraId, command: 'disconnect' });
      onCameraLeft(cameraId);
      break;
  }
}

// ── Fullscreen ─────────────────────────────────────────────────
// CSS-based fullscreen because Android WebView's native fullscreen API
// requires a custom WebChromeClient.onShowCustomView path that we don't
// implement. The CSS class works identically on every WebView.
function toggleFullscreen(cameraId) {
  const card = document.getElementById(`card-${cameraId}`);
  if (!card) return;
  const goingFull = !card.classList.contains('cam-fullscreen');
  // Only one card can be fullscreen at a time.
  document.querySelectorAll('.cam-card.cam-fullscreen').forEach(c => c.classList.remove('cam-fullscreen'));
  if (goingFull) card.classList.add('cam-fullscreen');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.cam-card.cam-fullscreen').forEach(c => c.classList.remove('cam-fullscreen'));
  }
});

// ── Snapshot ───────────────────────────────────────────────────
function takeSnapshot(cameraId) {
  const video = document.querySelector(`#card-${cameraId} .cam-video`);
  if (!video || !video.videoWidth) return;
  const targetH = resolvePhotoRes(photoQuality, video.videoHeight);
  const targetW = Math.round(video.videoWidth * targetH / video.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width  = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (video.classList.contains('mirror')) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, targetW, targetH);

  const peer     = peers.get(cameraId);
  const name     = (peer?.name || cameraId).replace(/\s+/g, '-');
  const filename = `camnet-${name}-${Date.now()}.jpg`;
  const dataUrl  = canvas.toDataURL('image/jpeg', JPEG_Q);

  // Shutter flash
  const card  = document.getElementById(`card-${cameraId}`);
  const flash = Object.assign(document.createElement('div'), {
    style: 'position:absolute;inset:0;background:#fff;opacity:0.75;pointer-events:none;' +
           'z-index:20;border-radius:inherit;transition:opacity 0.35s ease-out'
  });
  card.appendChild(flash);
  requestAnimationFrame(() => requestAnimationFrame(() => { flash.style.opacity = '0'; }));
  setTimeout(() => flash.remove(), 400);

  // Save via Android bridge (writes to DCIM/CamNet and shows a toast)
  if (typeof AndroidBridge !== 'undefined' && AndroidBridge.saveSnapshot) {
    AndroidBridge.saveSnapshot(dataUrl, filename);
  } else {
    // Browser fallback
    Object.assign(document.createElement('a'), { href: dataUrl, download: filename }).click();
  }
}

// ── Recording ──────────────────────────────────────────────────
const REC_SEGMENT_MS = 5 * 60 * 1000; // 5-minute segments for long recordings

async function startRecording(cameraId, target, durationMs) {
  const peer = peers.get(cameraId);
  if (!peer || peer.recordTarget) return;

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  peer.recordTarget   = target;
  peer.recDurationMs  = durationMs;
  peer.recStartTime   = Date.now();
  peer.recSegNum      = 0;
  peer.recBaseName    = `CamNet_${(peer.name || cameraId).replace(/[^a-zA-Z0-9]/g,'_')}_${ts}`;
  peer.recChunks      = [];

  showRecIndicator(cameraId, true);
  const targetLabel = target === 'both' ? 'camera + monitor' : target;
  showToast(`⏺ Recording started (${targetLabel})`);

  if (target === 'camera' || target === 'both') {
    wsSend({ type: 'camera-command', cameraId, command: 'record-start', value: { durationMs } });
  }
  if (target === 'monitor' || target === 'both') {
    if (!peer.stream) { showToast('No stream to record'); stopRecording(cameraId); return; }
    _startMonitorSegment(cameraId);
  }
  if (durationMs > 0) {
    peer.recDurationTimer = setTimeout(() => {
      stopRecording(cameraId);
      const b = document.querySelector(`#card-${cameraId} [data-action="record"]`);
      if (b) { b.textContent = '⏺'; b.classList.remove('active'); }
      showToast('📹 Recording complete');
    }, durationMs);
  }
}

function _startMonitorSegment(cameraId) {
  const peer = peers.get(cameraId);
  if (!peer || !peer.recordTarget || !peer.stream) return;

  const mimeType = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4']
    .find(m => MediaRecorder.isTypeSupported(m)) || '';
  const multiSegment = peer.recDurationMs === 0 || peer.recDurationMs > REC_SEGMENT_MS;

  peer.recChunks = [];
  try {
    const rec = new MediaRecorder(peer.stream, mimeType ? { mimeType } : {});
    peer.recorder = rec;
    rec.ondataavailable = e => { if (e.data.size) peer.recChunks.push(e.data); };
    rec.onstop = () => {
      if (peer.recChunks.length > 0) {
        const blob   = new Blob(peer.recChunks, { type: rec.mimeType });
        // Increment before async save so the number is locked in even if save is slow (item 9).
        // Do NOT reset peer.recChunks here — the next _startMonitorSegment resets it at its
        // top, avoiding a race where a late ondataavailable from the old recorder would land
        // in the new segment's array after an in-onstop reset (item 10).
        const segNum = peer.recSegNum++;
        const ext    = rec.mimeType.includes('mp4') ? 'mp4' : 'webm';
        const suffix = multiSegment ? `_part${String(segNum + 1).padStart(2,'0')}` : '';
        const filename = `${peer.recBaseName}${suffix}.${ext}`;
        _saveMonitorSegment(filename, blob, rec.mimeType);
      }
      peer.recorder = null;
      if (peer.recordTarget) _startMonitorSegment(cameraId); // chain next segment
    };
    rec.start(1000);

    const elapsed      = Date.now() - peer.recStartTime;
    const remaining    = peer.recDurationMs > 0 ? peer.recDurationMs - elapsed : Infinity;
    const segDuration  = Math.min(REC_SEGMENT_MS, remaining);
    peer.recSegTimer   = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, segDuration);
  } catch (e) {
    showToast('Monitor recording failed');
    console.warn('Monitor recording failed:', e);
  }
}

function stopRecording(cameraId) {
  const peer = peers.get(cameraId);
  if (!peer || !peer.recordTarget) return;
  clearTimeout(peer.recSegTimer);     peer.recSegTimer = null;
  clearTimeout(peer.recDurationTimer); peer.recDurationTimer = null;
  const target = peer.recordTarget;
  peer.recordTarget = null;
  if (peer.recorder && peer.recorder.state !== 'inactive') {
    peer.recorder.stop(); // triggers onstop → saves final segment
  } else {
    peer.recorder = null;
  }
  if (target === 'camera' || target === 'both') {
    wsSend({ type: 'camera-command', cameraId, command: 'record-stop' });
  }
  showRecIndicator(cameraId, false);
}

async function _saveMonitorSegment(filename, blob, mimeType) {
  try {
    const res = await fetch('/api/save-video', {
      method: 'POST',
      headers: { 'Content-Type': mimeType || 'video/webm', 'X-Filename': encodeURIComponent(filename) },
      body: await blob.arrayBuffer(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('📹 Saved to gallery');
  } catch {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    showToast('📹 Video downloaded');
  }
}

function showRecordingOptionsPicker(quality) {
  return new Promise((resolve) => {
    const MB_PER_MIN = { 240: 3, 480: 8, 720: 20, 1080: 50 };
    const q       = quality || 720;
    const mbPerMin = MB_PER_MIN[q] || 20;

    const durations = [
      { ms: 60_000,    label: '1 min'    },
      { ms: 180_000,   label: '3 min'    },
      { ms: 300_000,   label: '5 min', isDefault: true },
      { ms: 600_000,   label: '10 min'   },
      { ms: 1_800_000, label: '30 min'   },
      { ms: 0,         label: '∞ No limit' },
    ];
    const targets = [
      { value: 'camera',  label: '📱 Camera Phone'  },
      { value: 'monitor', label: '🖥️ Monitor (here)', isDefault: true },
      { value: 'both',    label: '📱🖥️ Both'          },
    ];

    let selDur = 300_000;
    let selTarget = 'monitor';

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9998;display:flex;align-items:flex-end;justify-content:center';

    const box = document.createElement('div');
    box.style.cssText = 'background:#1e293b;border-top:1.5px solid #334155;border-radius:20px 20px 0 0;padding:24px 20px 32px;width:100%;max-width:480px;display:flex;flex-direction:column;gap:16px';

    const heading = document.createElement('div');
    heading.textContent = '📹 Recording Options';
    heading.style.cssText = 'color:#f1f5f9;font-size:16px;font-weight:700;text-align:center';
    box.appendChild(heading);

    // ── Duration chips ──
    const durLabel = document.createElement('div');
    durLabel.textContent = 'Duration';
    durLabel.style.cssText = 'color:#94a3b8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px';
    box.appendChild(durLabel);

    const durRow = document.createElement('div');
    durRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
    const durBtns = new Map();

    function selectDur(ms) {
      selDur = ms;
      durBtns.forEach((b, k) => {
        const on = k === ms;
        b.style.borderColor = on ? '#3b82f6' : '#334155';
        b.style.background  = on ? 'rgba(59,130,246,0.15)' : 'transparent';
        b.style.color       = on ? '#60a5fa' : '#f1f5f9';
        b.style.fontWeight  = on ? '700' : '400';
      });
      updateEstimate();
    }

    for (const d of durations) {
      const b = document.createElement('button');
      b.textContent = d.label;
      b.style.cssText = `padding:8px 14px;border:1.5px solid ${d.isDefault ? '#3b82f6' : '#334155'};border-radius:20px;background:${d.isDefault ? 'rgba(59,130,246,0.15)' : 'transparent'};color:${d.isDefault ? '#60a5fa' : '#f1f5f9'};font-size:14px;font-weight:${d.isDefault ? '700' : '400'};cursor:pointer;-webkit-tap-highlight-color:transparent`;
      b.addEventListener('click', () => selectDur(d.ms));
      durBtns.set(d.ms, b);
      durRow.appendChild(b);
    }
    box.appendChild(durRow);

    // ── Save-on target ──
    const savLabel = document.createElement('div');
    savLabel.textContent = 'Save On';
    savLabel.style.cssText = 'color:#94a3b8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px';
    box.appendChild(savLabel);

    const savRow = document.createElement('div');
    savRow.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    const targetBtns = new Map();

    function selectTarget(v) {
      selTarget = v;
      targetBtns.forEach((b, k) => {
        const on = k === v;
        b.style.borderColor = on ? '#3b82f6' : '#334155';
        b.style.background  = on ? 'rgba(59,130,246,0.15)' : 'transparent';
        b.style.color       = on ? '#60a5fa' : '#f1f5f9';
        b.style.fontWeight  = on ? '700' : '400';
      });
    }

    for (const t of targets) {
      const b = document.createElement('button');
      b.textContent = t.label;
      b.style.cssText = `padding:12px 16px;border:1.5px solid ${t.isDefault ? '#3b82f6' : '#334155'};border-radius:10px;background:${t.isDefault ? 'rgba(59,130,246,0.15)' : 'transparent'};color:${t.isDefault ? '#60a5fa' : '#f1f5f9'};font-size:15px;font-weight:${t.isDefault ? '700' : '400'};cursor:pointer;text-align:left;-webkit-tap-highlight-color:transparent`;
      b.addEventListener('click', () => selectTarget(t.value));
      targetBtns.set(t.value, b);
      savRow.appendChild(b);
    }
    box.appendChild(savRow);

    // ── Estimate info ──
    const info = document.createElement('div');
    info.style.cssText = 'background:#0f172a;border-radius:10px;padding:10px 14px;font-size:12px;color:#64748b;line-height:1.6';
    box.appendChild(info);

    function updateEstimate() {
      const mins = selDur > 0 ? selDur / 60_000 : null;
      const mb   = mins ? Math.round(mins * mbPerMin) : null;
      const mbStr = mb ? (mb >= 1000 ? `${(mb/1000).toFixed(1)} GB` : `${mb} MB`) : `~${mbPerMin} MB/min`;
      const seg  = selDur === 0 || selDur > REC_SEGMENT_MS;
      let txt = `Quality: ${q}p  ·  Estimated size: ${mbStr}`;
      if (seg) txt += '\nSaved as 5-min segments for long recordings.';
      info.textContent = txt;
      info.style.whiteSpace = 'pre-line';
    }
    updateEstimate();

    // ── Start button ──
    const startBtn = document.createElement('button');
    startBtn.textContent = 'Start Recording';
    startBtn.style.cssText = 'padding:15px;background:#ef4444;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent';
    startBtn.addEventListener('click', () => { document.body.removeChild(overlay); resolve({ target: selTarget, durationMs: selDur }); });
    box.appendChild(startBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:10px;border:none;background:transparent;color:#64748b;font-size:14px;cursor:pointer';
    cancelBtn.addEventListener('click', () => { document.body.removeChild(overlay); resolve(null); });
    box.appendChild(cancelBtn);

    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(null); } });
    document.body.appendChild(overlay);
  });
}

function showRecIndicator(cameraId, show) {
  let ind = document.querySelector(`#card-${cameraId} .rec-indicator`);
  if (show && !ind) {
    ind = document.createElement('div');
    ind.className = 'rec-indicator';
    ind.innerHTML = '<div class="rec-dot"></div> REC';
    document.getElementById(`card-${cameraId}`).appendChild(ind);
  } else if (!show && ind) {
    ind.remove();
  }
}

// ── Motion detection ───────────────────────────────────────────
let motionNotifEnabled  = false;
let motionAutoSnap      = false;
let motionFlash         = false;
let motionFlashStillMins = 2;

function startMotion(cameraId) {
  const peer = peers.get(cameraId);
  const video = document.querySelector(`#card-${cameraId} .cam-video`);
  if (!peer || !video || peer.motion) return;

  motionNotifEnabled = 'Notification' in window && Notification.permission === 'granted';

  const canvas = document.createElement('canvas');
  canvas.style.display = 'none';
  document.getElementById(`card-${cameraId}`).appendChild(canvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let prev = null;
  let alertTimeout = null;
  let running = true;

  function analyze() {
    if (!running) return;
    const W = 160, H = 120;
    if (video.videoWidth === 0) { setTimeout(analyze, 500); return; }
    canvas.width = W; canvas.height = H;
    ctx.drawImage(video, 0, 0, W, H);
    const frame = ctx.getImageData(0, 0, W, H).data;

    if (prev) {
      const { pixelDiff, fraction } = SENS[motionSens];
      const zone = peer.zone;
      let changed = 0, total = 0;

      if (zone) {
        // Only diff pixels inside the drawn zone
        const x0 = Math.max(0, Math.floor(zone.x * W));
        const y0 = Math.max(0, Math.floor(zone.y * H));
        const x1 = Math.min(W, Math.ceil((zone.x + zone.w) * W));
        const y1 = Math.min(H, Math.ceil((zone.y + zone.h) * H));
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * W + x) * 4;
            const d = (Math.abs(frame[i]-prev[i]) + Math.abs(frame[i+1]-prev[i+1]) + Math.abs(frame[i+2]-prev[i+2])) / 3;
            if (d > pixelDiff) changed++;
            total++;
          }
        }
      } else {
        total = W * H;
        for (let i = 0; i < frame.length; i += 4) {
          const d = (Math.abs(frame[i]-prev[i]) + Math.abs(frame[i+1]-prev[i+1]) + Math.abs(frame[i+2]-prev[i+2])) / 3;
          if (d > pixelDiff) changed++;
        }
      }

      const now = Date.now();
      const aboveThreshold = total > 0 && changed / total > fraction;

      if (aboveThreshold) {
        peer.motionConsecutive = (peer.motionConsecutive || 0) + 1;
      } else {
        peer.motionConsecutive = 0;
      }

      if (peer.motionConsecutive >= MOTION_CONSECUTIVE_REQ &&
          now >= peer.lastMotionAt + MOTION_COOLDOWN_MS) {
        peer.motionConsecutive = 0; // reset after firing
        if (smartDetectionEnabled && cocoModel && !peer.pendingSmartDetect) {
          if (now < (peer.lastSmartAt || 0) + SMART_DETECTION_COOLDOWN_MS) {
            // skip — too soon since last inference
          } else {
            peer.lastSmartAt        = now;
            peer.pendingSmartDetect = true;
            runSmartDetection(video).then(matches => {
              peer.pendingSmartDetect = false;
              if (matches && matches.length > 0) {
                const best = matches.reduce((a, b) => a.score > b.score ? a : b);
                showMotionAlert(cameraId, best.class);
                fireNativeMotionAlert(cameraId);
                clearTimeout(alertTimeout);
                alertTimeout = setTimeout(() => hideMotionAlert(cameraId), 4000);
              }
            });
          }
        } else if (!smartDetectionEnabled || !cocoModel) {
          showMotionAlert(cameraId);
          fireNativeMotionAlert(cameraId);
          clearTimeout(alertTimeout);
          alertTimeout = setTimeout(() => hideMotionAlert(cameraId), 4000);
        }
      }
    }
    prev = frame.slice();
    setTimeout(analyze, 400);
  }

  peer.motion = { stop: () => { running = false; canvas.remove(); clearTimeout(alertTimeout); } };
  updateMotionIndicator(cameraId);
  analyze();
}

function stopMotion(cameraId) {
  const peer = peers.get(cameraId);
  if (!peer?.motion) return;
  peer.motion.stop();
  peer.motion = null;
  hideMotionAlert(cameraId);
  updateMotionIndicator(cameraId);
}

function updateMotionIndicator(cameraId) {
  const peer = peers.get(cameraId);
  const card = document.getElementById(`card-${cameraId}`);
  if (!card) return;
  let ind = card.querySelector('.motion-indicator');
  if (peer?.motion) {
    if (!ind) {
      ind = document.createElement('div');
      ind.className = 'motion-indicator';
      ind.innerHTML = '<span class="motion-indicator-dot"></span><span class="motion-indicator-text"></span>';
      card.appendChild(ind);
    }
    const ai = smartDetectionEnabled && cocoModel;
    let text;
    if (ai && peer.zone)      text = 'AI · ZONE';
    else if (ai)              text = 'AI WATCHING';
    else if (peer.zone)       text = 'WATCHING ZONE';
    else                      text = 'MOTION ON';
    ind.querySelector('.motion-indicator-text').textContent = text;
  } else {
    ind?.remove();
  }
}

function showMotionAlert(cameraId, detectedClass) {
  const peer = peers.get(cameraId);
  const card = document.getElementById(`card-${cameraId}`);
  if (!peer || !card) return;

  peer.lastMotionAt = Date.now();

  let al = card.querySelector('.motion-alert');
  if (!al) {
    al = document.createElement('div');
    al.className = 'motion-alert';
    card.appendChild(al);
  }
  const className = detectedClass ? detectedClass.charAt(0).toUpperCase() + detectedClass.slice(1) : null;
  al.textContent = className
    ? `⚠ ${className} detected${peer.zone ? ' in zone' : ''}`
    : (peer.zone ? '⚠ Motion in zone' : '⚠ Motion');
  al.classList.add('visible');

  if (motionNotifEnabled) {
    new Notification(`${className || 'Motion'} – ${peer.name || cameraId}`, {
      body: new Date().toLocaleTimeString(),
      icon: '/icons/icon-192.png',
      tag: `motion-${cameraId}`,
      silent: false,
    });
  }
  if (motionAutoSnap) takeSnapshot(cameraId);
  if (motionFlash && peer.facingMode !== 'user') triggerMotionFlash(cameraId);
}

function hideMotionAlert(cameraId) {
  document.querySelector(`#card-${cameraId} .motion-alert`)?.classList.remove('visible');
}

// Fires a native Android OS notification via AndroidBridge so alerts arrive
// when the app is backgrounded, screen is off, or user is in another app.
function fireNativeMotionAlert(cameraId) {
  const peer = peers.get(cameraId);
  if (!peer || !window.AndroidBridge?.fireMotionAlert) return;
  const name = peer.name || ('Camera ' + cameraId);
  let snapshotBase64 = '';
  try {
    const video = document.querySelector(`#card-${cameraId} video`);
    if (video && video.videoWidth > 0) {
      const cvs = document.createElement('canvas');
      cvs.width  = 320;
      cvs.height = Math.round(320 * video.videoHeight / video.videoWidth);
      cvs.getContext('2d').drawImage(video, 0, 0, cvs.width, cvs.height);
      snapshotBase64 = cvs.toDataURL('image/jpeg', 0.6);
    }
  } catch (_) {}
  window.AndroidBridge.fireMotionAlert(name, snapshotBase64);
}

// ── Motion flash ───────────────────────────────────────────────
function triggerMotionFlash(cameraId) {
  const peer = peers.get(cameraId);
  if (!peer || peer.facingMode === 'user') return;

  if (!peer.torchOn) {
    peer.torchOn = true;
    peer.motionFlashActive = true;
    wsSend({ type: 'camera-command', cameraId, command: 'torch-toggle' });
    const flashBtn = document.querySelector(`#card-${cameraId} [data-action="flash"]`);
    if (flashBtn) flashBtn.classList.add('active');
  }

  // Reset still timer on every motion event
  clearTimeout(peer.motionFlashTimer);
  peer.motionFlashTimer = setTimeout(() => {
    peer.motionFlashTimer = null;
    if (!peer.motionFlashActive || !peer.torchOn) return;
    peer.torchOn = false;
    peer.motionFlashActive = false;
    wsSend({ type: 'camera-command', cameraId, command: 'torch-toggle' });
    const flashBtn = document.querySelector(`#card-${cameraId} [data-action="flash"]`);
    if (flashBtn) flashBtn.classList.remove('active');
  }, motionFlashStillMins * 60 * 1000);
}

// ── Timelapse ──────────────────────────────────────────────────
function startTimelapse(cameraId, cfg) {
  const peer = peers.get(cameraId);
  if (!peer || peer.timelapse) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `TL_${(peer.name || cameraId).replace(/[^a-zA-Z0-9]/g, '_')}_${ts}`;
  peer.timelapse = { cfg, frames: [], photoCount: 0, base, durationTimer: null, intervalHandle: null };

  async function tick() {
    const blob = await _captureTlFrame(cameraId);
    if (!blob || !peer.timelapse) return;
    const tl = peer.timelapse;
    tl.photoCount++;
    const suffix = `_${String(tl.photoCount).padStart(4, '0')}`;
    if (cfg.mode === 'photos' || cfg.mode === 'both') {
      _saveTlPhoto(blob, `${base}${suffix}.jpg`);
    }
    if (cfg.mode === 'video' || cfg.mode === 'both') {
      if (tl.frames.length >= 1000) {
        showToast('⚠ Timelapse frame cap reached (1000) — stopping');
        stopTimelapse(cameraId); return;
      }
      if (tl.frames.length === 800) showToast('⚠ Timelapse approaching frame cap (800/1000)');
      tl.frames.push(blob);
    }
    _updateTlIndicator(cameraId);
  }

  tick(); // capture immediately on start
  peer.timelapse.intervalHandle = setInterval(tick, cfg.intervalMs);
  showToast(`⏱ Timelapse started — ${cfg.mode === 'both' ? 'photos + video' : cfg.mode}`);

  if (cfg.durationMs > 0) {
    peer.timelapse.durationTimer = setTimeout(() => {
      stopTimelapse(cameraId);
      const b = document.querySelector(`#card-${cameraId} [data-action="timelapse"]`);
      if (b) b.classList.remove('active');
      showToast('⏱ Timelapse complete');
    }, cfg.durationMs);
  }
}

function stopTimelapse(cameraId) {
  const peer = peers.get(cameraId);
  const tl = peer?.timelapse;
  if (!tl) return;
  clearInterval(tl.intervalHandle);
  clearTimeout(tl.durationTimer);
  peer.timelapse = null;
  _updateTlIndicator(cameraId);

  if ((tl.cfg.mode === 'video' || tl.cfg.mode === 'both') && tl.frames.length > 0) {
    showToast('⏱ Rendering timelapse video…');
    _renderTlVideo(tl.frames, tl.cfg.videoQuality).then(blob => {
      if (!blob) return;
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      _saveMonitorSegment(`${tl.base}_timelapse.${ext}`, blob, blob.type);
    });
  }
}

async function _captureTlFrame(cameraId) {
  const peer = peers.get(cameraId);
  const video = document.querySelector(`#card-${cameraId} .cam-video`);
  if (!video || !video.videoWidth) return null;
  // Photo quality: if the timelapse cfg overrides it, use that; otherwise global setting.
  const choice = peer?.timelapse?.cfg?.photoQuality ?? photoQuality;
  const targetH = resolvePhotoRes(choice, video.videoHeight);
  return captureVideoFrameJpeg(video, targetH, JPEG_Q);
}

async function _saveTlPhoto(blob, filename) {
  if (window.AndroidBridge) {
    const reader = new FileReader();
    reader.onloadend = () => window.AndroidBridge.saveSnapshot(reader.result, filename);
    reader.readAsDataURL(blob);
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

async function _renderTlVideo(frames, videoQualityRes) {
  try {
    const bitmaps = await Promise.all(frames.map(b => createImageBitmap(b)));
    if (!bitmaps.length) return null;
    // Output canvas size: scale to videoQualityRes (height-bound), preserving aspect.
    const srcW = bitmaps[0].width, srcH = bitmaps[0].height;
    const targetH = Math.min(videoQualityRes || srcH, srcH);
    const targetW = Math.round(srcW * targetH / srcH);
    const canvas  = document.createElement('canvas');
    canvas.width  = targetW;
    canvas.height = targetH;
    const ctx     = canvas.getContext('2d');
    const mimeType = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    const stream  = canvas.captureStream(24);
    const bps     = VIDEO_BPS_AT_RES[targetH] || VIDEO_BPS_AT_RES[720];
    const rec     = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bps });
    const chunks  = [];
    return new Promise(resolve => {
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        bitmaps.forEach(b => b.close());
        resolve(new Blob(chunks, { type: rec.mimeType }));
      };
      rec.start();
      let i = 0;
      const frameDuration = 1000 / 24;
      const startTime = performance.now();
      (function tick(now) {
        if (i >= bitmaps.length) { rec.stop(); return; }
        // Use wall-clock position so the browser can yield between frames
        // without causing frame drift. Skip forward if we're behind.
        const expectedFrame = Math.floor((now - startTime) / frameDuration);
        if (expectedFrame > i) i = Math.min(expectedFrame, bitmaps.length - 1);
        ctx.drawImage(bitmaps[i++], 0, 0, targetW, targetH);
        requestAnimationFrame(tick);
      })(startTime);
    });
  } catch (e) {
    console.warn('Timelapse render failed:', e);
    showToast('Timelapse render failed');
    return null;
  }
}

function _updateTlIndicator(cameraId) {
  const peer = peers.get(cameraId);
  const card = document.getElementById(`card-${cameraId}`);
  if (!card) return;
  let ind = card.querySelector('.tl-indicator');
  if (peer?.timelapse) {
    if (!ind) {
      ind = document.createElement('div');
      ind.className = 'tl-indicator';
      card.appendChild(ind);
    }
    const tl = peer.timelapse;
    const modeIcon = tl.cfg.mode === 'photos' ? '📸' : tl.cfg.mode === 'video' ? '🎬' : '📸🎬';
    ind.textContent = `⏱ ${modeIcon} ${tl.photoCount}`;
  } else {
    ind?.remove();
  }
}

function showTimelapsePicker(streamQuality) {
  return new Promise(resolve => {
    const streamRes = parseInt(streamQuality, 10) || 720;

    // State
    let selMode      = 'photos';
    let intervalVal  = 1,   intervalUnit = 'm';  // 1 minute
    let durationVal  = 8,   durationUnit = 'h';  // 8 hours
    let unlimited    = false;
    let useGlobalPhotoQ = true;
    let localPhotoQ  = photoQuality;
    let selVideoQ    = String(streamRes);

    const UNIT_SEC = { s: 1, m: 60, h: 3600 };

    // ── Build UI ──────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9998;display:flex;align-items:flex-end;justify-content:center;overflow-y:auto';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e293b;border-top:1.5px solid #334155;border-radius:20px 20px 0 0;padding:22px 20px 32px;width:100%;max-width:480px;display:flex;flex-direction:column;gap:12px';

    const heading = document.createElement('div');
    heading.textContent = '⏱ Timelapse Options';
    heading.style.cssText = 'color:#f1f5f9;font-size:16px;font-weight:700;text-align:center';
    box.appendChild(heading);

    function makeLabel(text) {
      const lbl = document.createElement('div');
      lbl.textContent = text;
      lbl.style.cssText = 'color:#94a3b8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px';
      return lbl;
    }

    function makeChipsRow(items, initialVal, onChange) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
      const btns = new Map();
      function paint(val) {
        btns.forEach((b, k) => {
          const on = k === val;
          b.style.borderColor = on ? '#3b82f6' : '#334155';
          b.style.background  = on ? 'rgba(59,130,246,0.15)' : 'transparent';
          b.style.color       = on ? '#60a5fa' : '#f1f5f9';
          b.style.fontWeight  = on ? '700' : '400';
        });
      }
      for (const it of items) {
        const b = document.createElement('button');
        b.textContent = it.label;
        b.style.cssText = 'padding:7px 13px;border:1.5px solid #334155;border-radius:18px;background:transparent;color:#f1f5f9;font-size:13px;font-weight:400;cursor:pointer;-webkit-tap-highlight-color:transparent';
        b.addEventListener('click', () => { paint(it.value); onChange(it.value); });
        btns.set(it.value, b);
        row.appendChild(b);
      }
      paint(initialVal);
      return row;
    }

    function makeNumberUnitRow(initVal, initUnit, units, onChange) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:8px;align-items:stretch';
      const input = document.createElement('input');
      input.type = 'number'; input.min = '1'; input.value = String(initVal);
      input.inputMode = 'numeric';
      input.style.cssText = 'flex:1;padding:11px 14px;border:1.5px solid #334155;border-radius:10px;background:#0f172a;color:#f1f5f9;font-size:16px;font-weight:600;text-align:center;outline:none;-moz-appearance:textfield';
      const select = document.createElement('select');
      select.style.cssText = 'padding:11px 12px;border:1.5px solid #334155;border-radius:10px;background:#0f172a;color:#f1f5f9;font-size:14px;font-weight:500;outline:none;min-width:96px;cursor:pointer';
      for (const u of units) {
        const opt = document.createElement('option');
        opt.value = u.value; opt.textContent = u.label;
        if (u.value === initUnit) opt.selected = true;
        select.appendChild(opt);
      }
      function emit() {
        const v = Math.max(1, parseInt(input.value, 10) || 1);
        onChange(v, select.value);
      }
      input.addEventListener('input', emit);
      select.addEventListener('change', emit);
      wrap.appendChild(input); wrap.appendChild(select);
      return wrap;
    }

    // Mode
    box.appendChild(makeLabel('Capture Mode'));
    box.appendChild(makeChipsRow(
      [
        { value: 'photos', label: '📸 Photos' },
        { value: 'video',  label: '🎬 Video' },
        { value: 'both',   label: '📸🎬 Both' },
      ],
      selMode,
      v => { selMode = v; refreshSections(); updateEstimate(); },
    ));

    // Interval
    box.appendChild(makeLabel('Interval'));
    box.appendChild(makeNumberUnitRow(
      intervalVal, intervalUnit,
      [{ value: 's', label: 'seconds' }, { value: 'm', label: 'minutes' }, { value: 'h', label: 'hours' }],
      (v, u) => { intervalVal = v; intervalUnit = u; updateEstimate(); },
    ));

    // Duration + Unlimited
    box.appendChild(makeLabel('Duration'));
    const durationWrap = document.createElement('div');
    durationWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    const durationRow = makeNumberUnitRow(
      durationVal, durationUnit,
      [{ value: 'm', label: 'minutes' }, { value: 'h', label: 'hours' }],
      (v, u) => { durationVal = v; durationUnit = u; updateEstimate(); },
    );
    durationWrap.appendChild(durationRow);
    const unlimitedLbl = document.createElement('label');
    unlimitedLbl.style.cssText = 'display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:13px;cursor:pointer;-webkit-tap-highlight-color:transparent;padding:4px 2px';
    const unlimitedCb = document.createElement('input');
    unlimitedCb.type = 'checkbox';
    unlimitedCb.style.cssText = 'width:18px;height:18px;accent-color:#3b82f6';
    unlimitedCb.addEventListener('change', () => {
      unlimited = unlimitedCb.checked;
      durationRow.style.opacity  = unlimited ? '0.4' : '1';
      durationRow.style.pointerEvents = unlimited ? 'none' : 'auto';
      updateEstimate();
    });
    unlimitedLbl.appendChild(unlimitedCb);
    unlimitedLbl.appendChild(document.createTextNode('Unlimited (run until manually stopped)'));
    durationWrap.appendChild(unlimitedLbl);
    box.appendChild(durationWrap);

    // Photo Quality (conditional on mode)
    const photoSection = document.createElement('div');
    photoSection.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    photoSection.appendChild(makeLabel('Photo Quality'));
    const globalLbl = document.createElement('label');
    globalLbl.style.cssText = 'display:flex;align-items:center;gap:8px;color:#cbd5e1;font-size:13px;cursor:pointer;-webkit-tap-highlight-color:transparent';
    const globalCb = document.createElement('input');
    globalCb.type = 'checkbox'; globalCb.checked = true;
    globalCb.style.cssText = 'width:18px;height:18px;accent-color:#3b82f6';
    const globalText = document.createElement('span');
    function globalLabelText() {
      return `Use global setting (${photoQuality === 'source' ? 'Source' : photoQuality + 'p'})`;
    }
    globalText.textContent = globalLabelText();
    globalLbl.appendChild(globalCb); globalLbl.appendChild(globalText);
    photoSection.appendChild(globalLbl);
    const photoChips = makeChipsRow(
      [
        { value: '480',    label: '480p' },
        { value: '720',    label: '720p' },
        { value: '1080',   label: '1080p' },
        { value: 'source', label: 'Source' },
      ],
      localPhotoQ,
      v => { localPhotoQ = v; updateEstimate(); },
    );
    photoSection.appendChild(photoChips);
    globalCb.addEventListener('change', () => {
      useGlobalPhotoQ = globalCb.checked;
      photoChips.style.display = useGlobalPhotoQ ? 'none' : 'flex';
      globalText.textContent = globalLabelText();
      updateEstimate();
    });
    photoChips.style.display = 'none'; // hidden by default (using global)
    box.appendChild(photoSection);

    // Video Quality (conditional on mode)
    const videoSection = document.createElement('div');
    videoSection.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    videoSection.appendChild(makeLabel('Video Quality'));
    videoSection.appendChild(makeChipsRow(
      [
        { value: '240',  label: '240p' },
        { value: '480',  label: '480p' },
        { value: '720',  label: '720p' },
        { value: '1080', label: '1080p' },
      ],
      selVideoQ,
      v => { selVideoQ = v; updateEstimate(); },
    ));
    box.appendChild(videoSection);

    function refreshSections() {
      photoSection.style.display = (selMode === 'photos' || selMode === 'both') ? 'flex' : 'none';
      videoSection.style.display = (selMode === 'video'  || selMode === 'both') ? 'flex' : 'none';
    }
    refreshSections();

    // ── Estimate ─────────────────────────────────────────────
    const info = document.createElement('div');
    info.style.cssText = 'background:#0f172a;border-radius:10px;padding:12px 14px;font-size:12px;color:#94a3b8;line-height:1.55;white-space:pre-line';
    box.appendChild(info);

    function updateEstimate() {
      const intervalMs = intervalVal * UNIT_SEC[intervalUnit] * 1000;
      const durationMs = unlimited ? 0 : durationVal * UNIT_SEC[durationUnit] * 1000;
      const frames = unlimited ? null : Math.max(1, Math.round(durationMs / intervalMs));
      const effPhotoH = resolvePhotoRes(useGlobalPhotoQ ? photoQuality : localPhotoQ, streamRes);
      const effVideoH = Math.min(parseInt(selVideoQ, 10), streamRes);

      const lines = [];
      if (frames !== null) {
        lines.push(`${frames.toLocaleString()} captures over ${formatDurationMs(durationMs)} (every ${formatDurationMs(intervalMs)})`);
      } else {
        const perHr = Math.round(3600 / (intervalMs / 1000));
        lines.push(`Unlimited — ${perHr.toLocaleString()} captures/hour at this interval`);
      }

      let totalBytes = 0;
      if (selMode === 'photos' || selMode === 'both') {
        const jpegB = estimateJpegBytes(effPhotoH);
        if (frames !== null) {
          const photoB = jpegB * frames;
          totalBytes += photoB;
          lines.push(`Photos:  ${formatBytes(photoB)}   (${frames}× ~${formatBytes(jpegB)} at ${effPhotoH}p)`);
        } else {
          lines.push(`Photos:  ~${formatBytes(jpegB)} each at ${effPhotoH}p`);
        }
      }
      if (selMode === 'video' || selMode === 'both') {
        if (frames !== null) {
          const videoSec   = frames / 24;
          const videoB     = Math.round(VIDEO_BPS_AT_RES[effVideoH] * videoSec / 8);
          totalBytes += videoB;
          lines.push(`Video:   ${formatBytes(videoB)}   (${videoSec.toFixed(1)}s at ${effVideoH}p, 24 fps)`);
        } else {
          lines.push(`Video:   rendered on stop at ${effVideoH}p`);
        }
      }
      if (totalBytes > 0 && selMode === 'both') {
        lines.push(`Total:   ${formatBytes(totalBytes)}`);
      }
      if (frames !== null && frames > 800) {
        lines.push('⚠ High frame count — video render may take a while.');
      }
      info.textContent = lines.join('\n');
    }
    updateEstimate();

    // ── Action buttons ──────────────────────────────────────
    const startBtn = document.createElement('button');
    startBtn.textContent = 'Start Timelapse';
    startBtn.style.cssText = 'padding:15px;background:#3b82f6;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent;margin-top:4px';
    startBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve({
        mode: selMode,
        intervalMs: intervalVal * UNIT_SEC[intervalUnit] * 1000,
        durationMs: unlimited ? 0 : durationVal * UNIT_SEC[durationUnit] * 1000,
        photoQuality: useGlobalPhotoQ ? null : localPhotoQ, // null = follow global
        videoQuality: Math.min(parseInt(selVideoQ, 10), streamRes),
      });
    });
    box.appendChild(startBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:10px;border:none;background:transparent;color:#64748b;font-size:14px;cursor:pointer';
    cancelBtn.addEventListener('click', () => { document.body.removeChild(overlay); resolve(null); });
    box.appendChild(cancelBtn);

    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(null); } });
    document.body.appendChild(overlay);
  });
}

// ── Detection zone editor ──────────────────────────────────────
function openZoneEditor(cameraId) {
  const peer = peers.get(cameraId);
  const card = document.getElementById(`card-${cameraId}`);
  if (!peer || !card) return;
  if (card.querySelector('.zone-editor')) return; // already open

  const editor = document.createElement('div');
  editor.className = 'zone-editor';
  editor.style.cssText = 'position:absolute;inset:0;z-index:25;cursor:crosshair;touch-action:none;user-select:none';
  editor.addEventListener('click', e => e.stopPropagation());

  // Darkened backdrop
  const backdrop = document.createElement('div');
  backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.45);pointer-events:none';
  editor.appendChild(backdrop);

  // Instruction
  const hint = document.createElement('div');
  hint.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.75);color:#f1f5f9;font-size:12px;font-weight:600;padding:5px 12px;border-radius:20px;pointer-events:none;white-space:nowrap;z-index:1';
  hint.textContent = peer.zone ? 'Drag to redraw, or tap Clear Zone' : 'Drag to draw detection zone';
  editor.appendChild(hint);

  // Live zone rectangle
  const zoneRect = document.createElement('div');
  zoneRect.style.cssText = 'position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.18);display:none;box-sizing:border-box;pointer-events:none';
  editor.appendChild(zoneRect);

  // Buttons row
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'position:absolute;bottom:10px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:1';

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Set Zone';
  confirmBtn.style.cssText = 'display:none;padding:8px 18px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer';

  const clearBtn = document.createElement('button');
  clearBtn.textContent = peer.zone ? '🗑 Clear Zone' : 'Full Frame';
  clearBtn.style.cssText = `padding:8px 14px;background:${peer.zone ? '#dc2626' : 'rgba(30,41,59,0.9)'};color:#fff;border:1.5px solid ${peer.zone ? '#dc2626' : '#475569'};border-radius:10px;font-size:13px;font-weight:600;cursor:pointer`;

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:8px 14px;background:transparent;color:#94a3b8;border:none;font-size:13px;cursor:pointer';

  btnRow.appendChild(confirmBtn);
  btnRow.appendChild(clearBtn);
  btnRow.appendChild(cancelBtn);
  editor.appendChild(btnRow);
  card.appendChild(editor);

  // Pre-draw existing zone
  let pendingZone = peer.zone ? { ...peer.zone } : null;
  if (pendingZone) {
    _applyZoneRect(zoneRect, pendingZone);
    zoneRect.style.display = 'block';
    confirmBtn.style.display = 'block';
  }

  // Drag logic
  let dragStart = null;

  function relPos(e) {
    const r = editor.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: Math.max(0, Math.min(1, (cx - r.left)  / r.width)),
      y: Math.max(0, Math.min(1, (cy - r.top)   / r.height)),
    };
  }

  editor.addEventListener('mousedown', e => { dragStart = relPos(e); });
  editor.addEventListener('touchstart', e => { dragStart = relPos(e); }, { passive: true });

  function onDrag(e) {
    if (!dragStart) return;
    const cur = relPos(e);
    const z = {
      x: Math.min(dragStart.x, cur.x),
      y: Math.min(dragStart.y, cur.y),
      w: Math.abs(cur.x - dragStart.x),
      h: Math.abs(cur.y - dragStart.y),
    };
    _applyZoneRect(zoneRect, z);
    zoneRect.style.display = 'block';
    pendingZone = z.w > 0.04 && z.h > 0.04 ? z : null;
    confirmBtn.style.display = pendingZone ? 'block' : 'none';
  }
  editor.addEventListener('mousemove', onDrag);
  editor.addEventListener('touchmove', e => { e.preventDefault(); onDrag(e); }, { passive: false });

  const endDrag = () => { dragStart = null; };
  editor.addEventListener('mouseup',  endDrag);
  editor.addEventListener('touchend', endDrag);

  confirmBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (pendingZone) peer.zone = pendingZone;
    updateZoneOverlay(cameraId);
    editor.remove();
    // Auto-enable motion detection when a zone is confirmed — setting a zone
    // without enabling motion does nothing visible, which is the most common
    // "why isn't this working" trap.
    if (peer.zone && !peer.motion) {
      startMotion(cameraId);
      const motionBtn = document.querySelector(`#card-${cameraId} [data-action="motion"]`);
      if (motionBtn) motionBtn.classList.add('active');
      showToast('🔳 Zone set · 🎯 Motion detection enabled');
    } else if (peer.zone) {
      updateMotionIndicator(cameraId);
      showToast('🔳 Zone set');
    } else {
      updateMotionIndicator(cameraId);
    }
  });
  clearBtn.addEventListener('click', e => {
    e.stopPropagation();
    const had = !!peer.zone;
    peer.zone = null;
    updateZoneOverlay(cameraId);
    updateMotionIndicator(cameraId);
    editor.remove();
    showToast(had ? '🔳 Zone cleared — watching full frame' : '🔳 Full frame mode');
  });
  cancelBtn.addEventListener('click', e => { e.stopPropagation(); editor.remove(); });
}

function _applyZoneRect(el, z) {
  el.style.left   = `${z.x * 100}%`;
  el.style.top    = `${z.y * 100}%`;
  el.style.width  = `${z.w * 100}%`;
  el.style.height = `${z.h * 100}%`;
}

function updateZoneOverlay(cameraId) {
  const peer = peers.get(cameraId);
  const card = document.getElementById(`card-${cameraId}`);
  if (!card) return;

  let ov = card.querySelector('.zone-overlay');
  const zoneBtn = card.querySelector('[data-action="zone"]');

  if (!peer?.zone) {
    ov?.remove();
    if (zoneBtn) { zoneBtn.classList.remove('active'); zoneBtn.title = 'Detection zone'; }
    return;
  }

  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'zone-overlay';
    ov.style.cssText = 'position:absolute;border:2px dashed rgba(59,130,246,0.8);pointer-events:none;box-sizing:border-box';
    // Corner label
    const lbl = document.createElement('div');
    lbl.className = 'zone-label';
    lbl.textContent = 'ZONE';
    lbl.style.cssText = 'position:absolute;top:-1px;left:0;background:#3b82f6;color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:0 0 4px 0;letter-spacing:0.5px';
    ov.appendChild(lbl);
    card.appendChild(ov);
  }
  _applyZoneRect(ov, peer.zone);
  if (zoneBtn) { zoneBtn.classList.add('active'); zoneBtn.title = 'Detection zone (active — tap to edit)'; }
}

// ── Rename ─────────────────────────────────────────────────────
let renamingId = null;
function openRename(cameraId) {
  const peer = peers.get(cameraId);
  if (!peer) return;
  renamingId = cameraId;
  document.getElementById('renameInput').value = peer.name;
  openPanel('renamePanel');
}

document.getElementById('renameConfirmBtn').addEventListener('click', () => {
  if (!renamingId) return;
  const val = document.getElementById('renameInput').value.trim();
  if (!val) return;
  const peer = peers.get(renamingId);
  if (peer) {
    peer.name = val;
    const el = document.getElementById(`name-${renamingId}`);
    if (el) el.textContent = val;
  }
  closePanel('renamePanel');
});

// ── Panel helpers ──────────────────────────────────────────────
function openPanel(id)  { document.getElementById(id).classList.remove('hidden'); }
function closePanel(id) { document.getElementById(id).classList.add('hidden'); }

document.querySelectorAll('.panel-backdrop, .panel-close').forEach(el => {
  el.addEventListener('click', () => closePanel(el.dataset.close));
});

// ── Header controls ────────────────────────────────────────────
document.getElementById('layoutBtn').addEventListener('click',  () => openPanel('layoutPanel'));
document.getElementById('sessionBtn').addEventListener('click', () => openPanel('sessionPanel'));
document.getElementById('settingsBtn').addEventListener('click', () => {
  // Sync all toggle UI states to current values before opening
  document.getElementById('globalMotionToggle').classList.toggle('on', globalMotion);
  document.getElementById('motionAutoSnapToggle').classList.toggle('on', motionAutoSnap);
  document.getElementById('motionFlashToggle').classList.toggle('on', motionFlash);
  document.getElementById('smartDetectionToggle').classList.toggle('on', smartDetectionEnabled);
  document.getElementById('muteAllToggle').classList.toggle('on', muteAll);
  document.getElementById('mirrorToggle').classList.toggle('on', mirrorFront);
  openPanel('settingsPanel');
  // Web Notification permission not needed — native AndroidBridge.fireMotionAlert
  // fires OS notifications directly via NotificationManager, bypassing the Web API.
});

// Layout selector
document.getElementById('layoutSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-layout]');
  if (!btn) return;
  document.querySelectorAll('#layoutSeg .seg-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const grid = document.getElementById('feedGrid');
  grid.classList.remove('l-auto','l-1','l-2','l-3');
  grid.classList.add(btn.dataset.layout);
  currentLayout = btn.dataset.layout;
  lsSave('currentLayout', currentLayout);
  closePanel('layoutPanel');
});

// Session panel actions
document.getElementById('copyCodeBtn').addEventListener('click',    () => copyToClipboard(roomId, 'Code copied!'));
document.getElementById('copyLinkBtn').addEventListener('click',    () => copyToClipboard(joinURL, 'Link copied!'));
document.getElementById('panelCopyCode').addEventListener('click',  () => copyToClipboard(roomId, 'Code copied!'));
document.getElementById('panelCopyLink').addEventListener('click',  () => copyToClipboard(joinURL, 'Link copied!'));
document.getElementById('newSessionBtn').addEventListener('click',  () => {
  closePanel('sessionPanel');
  sessionStorage.removeItem('camnet_room'); // prevent stale room rejoin on next page load
  wsSend({ type: 'create-room' });
  peers.forEach((_, id) => onCameraLeft(id));
});

// Settings toggles
document.getElementById('globalMotionToggle').addEventListener('click', function() {
  globalMotion = !globalMotion;
  this.classList.toggle('on', globalMotion);
  lsSave('globalMotion', globalMotion);
  peers.forEach((_, id) => {
    if (globalMotion) startMotion(id);
    else              stopMotion(id);
  });
});

document.getElementById('muteAllToggle').addEventListener('click', function() {
  muteAll = !muteAll;
  this.classList.toggle('on', muteAll);
  lsSave('muteAll', muteAll);
  document.querySelectorAll('.cam-video').forEach(v => v.muted = muteAll);
});

document.getElementById('mirrorToggle').addEventListener('click', function() {
  mirrorFront = !mirrorFront;
  this.classList.toggle('on', mirrorFront);
  lsSave('mirrorFront', mirrorFront);
  peers.forEach((_, id) => applyMirror(id));
});

document.getElementById('motionAutoSnapToggle').addEventListener('click', function() {
  motionAutoSnap = !motionAutoSnap;
  this.classList.toggle('on', motionAutoSnap);
  lsSave('motionAutoSnap', motionAutoSnap);
});

document.getElementById('motionFlashToggle').addEventListener('click', function() {
  motionFlash = !motionFlash;
  this.classList.toggle('on', motionFlash);
  lsSave('motionFlash', motionFlash);
  document.getElementById('motionFlashStillRow').style.display = motionFlash ? '' : 'none';
});

document.getElementById('motionFlashStillSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mins]');
  if (!btn) return;
  document.querySelectorAll('#motionFlashStillSeg .seg-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  motionFlashStillMins = parseInt(btn.dataset.mins, 10);
  lsSave('motionFlashStillMins', motionFlashStillMins);
});

document.getElementById('motionSensSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sens]');
  if (!btn) return;
  document.querySelectorAll('#motionSensSeg .seg-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  motionSens = btn.dataset.sens;
  lsSave('motionSens', motionSens);
});

document.getElementById('photoQualitySeg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-q]');
  if (!btn) return;
  document.querySelectorAll('#photoQualitySeg .seg-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  photoQuality = btn.dataset.q;
  lsSave('photoQuality', photoQuality);
});

// ── Smart detection (AI) wiring ─────────────────────────────────
(function buildSmartClassChips() {
  const container = document.getElementById('smartClassesContainer');
  if (!container) return;
  for (const c of SMART_CLASS_OPTIONS) {
    const chip = document.createElement('button');
    chip.dataset.value = c.value;
    chip.textContent = c.label;
    const on = c.defaultOn === true;
    if (on) smartClasses.add(c.value);
    chip.style.cssText = `padding:6px 12px;border:1.5px solid ${on?'#3b82f6':'#334155'};border-radius:18px;background:${on?'rgba(59,130,246,0.15)':'transparent'};color:${on?'#60a5fa':'#f1f5f9'};font-size:13px;font-weight:${on?'700':'400'};cursor:pointer;-webkit-tap-highlight-color:transparent`;
    chip.addEventListener('click', () => {
      const isOn = smartClasses.has(c.value);
      if (isOn) smartClasses.delete(c.value);
      else      smartClasses.add(c.value);
      const nowOn = !isOn;
      chip.style.borderColor = nowOn ? '#3b82f6' : '#334155';
      chip.style.background  = nowOn ? 'rgba(59,130,246,0.15)' : 'transparent';
      chip.style.color       = nowOn ? '#60a5fa' : '#f1f5f9';
      chip.style.fontWeight  = nowOn ? '700' : '400';
      lsSave('smartClasses', [...smartClasses]);
    });
    container.appendChild(chip);
  }
})();

document.getElementById('smartDetectionToggle').addEventListener('click', async function() {
  smartDetectionEnabled = !smartDetectionEnabled;
  this.classList.toggle('on', smartDetectionEnabled);
  lsSave('smartDetectionEnabled', smartDetectionEnabled);
  document.getElementById('smartDetectionStatusRow').style.display = smartDetectionEnabled ? '' : 'none';
  document.getElementById('smartClassesRow').style.display        = smartDetectionEnabled ? 'flex' : 'none';
  if (smartDetectionEnabled) {
    showToast('🧠 Smart detection enabling…');
    try {
      await loadCocoModel();
      showToast('🧠 AI ready');
      // Refresh indicator on cameras that have motion on
      peers.forEach((_, id) => updateMotionIndicator(id));
    } catch {
      // already toasted
    }
  } else {
    showToast('Smart detection off');
    peers.forEach((_, id) => updateMotionIndicator(id));
  }
});

// Rename input – enter key
document.getElementById('renameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('renameConfirmBtn').click();
});

// ── Clipboard ──────────────────────────────────────────────────
function copyToClipboard(text, toast) {
  navigator.clipboard?.writeText(text).then(() => showToast(toast)).catch(() => {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    el.remove();
    showToast(toast);
  });
}

function showToast(msg) {
  let t = document.getElementById('_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '_toast';
    t.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:rgba(255,255,255,0.12);backdrop-filter:blur(10px);color:#fff;padding:10px 20px;border-radius:30px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none;transition:opacity 0.3s';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.style.opacity = '0', 2000);
}

// ── Quality picker ─────────────────────────────────────────────
function showQualityPicker(quals, current) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9998;display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e293b;border:1.5px solid #334155;border-radius:16px;padding:20px;min-width:220px;display:flex;flex-direction:column;gap:10px';
    const title = document.createElement('div');
    title.textContent = 'Select Quality';
    title.style.cssText = 'color:#94a3b8;font-size:13px;font-weight:600;text-align:center;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px';
    box.appendChild(title);
    for (const q of quals) {
      const btn = document.createElement('button');
      btn.textContent = q === current ? `${q}p ✓` : `${q}p`;
      btn.style.cssText = `padding:12px;border:1.5px solid ${q === current ? '#3b82f6' : '#334155'};border-radius:10px;background:${q === current ? 'rgba(59,130,246,0.15)' : 'transparent'};color:#f1f5f9;font-size:16px;font-weight:${q === current ? '700' : '400'};cursor:pointer;-webkit-tap-highlight-color:transparent`;
      btn.addEventListener('click', () => { document.body.removeChild(overlay); resolve(q); });
      box.appendChild(btn);
    }
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:10px;border:none;background:transparent;color:#64748b;font-size:14px;cursor:pointer;margin-top:2px';
    cancel.addEventListener('click', () => { document.body.removeChild(overlay); resolve(null); });
    box.appendChild(cancel);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(null); } });
    document.body.appendChild(overlay);
  });
}

// ── Latency ping ───────────────────────────────────────────────
let pingIntervalId = null;
function startPing() {
  if (pingIntervalId) return;
  pingIntervalId = setInterval(() => wsSend({ type: 'ping', ts: Date.now() }), 5000);
}
function stopPing() {
  clearInterval(pingIntervalId);
  pingIntervalId = null;
}

// ── Settings reset ─────────────────────────────────────────────
document.getElementById('resetSettingsBtn').addEventListener('click', () => {
  if (!confirm('Reset all settings to defaults and reload?')) return;
  Object.keys(localStorage)
    .filter(k => k.startsWith('camnet.viewer.'))
    .forEach(k => localStorage.removeItem(k));
  location.reload();
});

// ── Escape key closes panels ───────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    ['sessionPanel','layoutPanel','settingsPanel','renamePanel'].forEach(closePanel);
  }
});

// ── Utils ──────────────────────────────────────────────────────
function escHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── Boot ───────────────────────────────────────────────────────
// Fetch LAN IP before connecting so the QR is correct from the start.
// /api/info is excluded from SW cache so this is always fresh.
fetch('/api/info')
  .then(r => r.json())
  .then(d => {
    // Camera phones connect via the SSL proxy, not the viewer's own HTTP port.
    const sslPort = d.sslPort || 3443;
    const box  = document.getElementById('serverUrlBox');
    const disp = document.getElementById('serverUrlDisplay');

    // Use best-guess IP for QR; show ALL detected IPs so user can pick if wrong
    const ips = d.lanIP
      ? [d.lanIP, ...(d.allIPs || []).map(i => i.address).filter(a => a !== d.lanIP)]
      : (d.allIPs || []).map(i => i.address);

    if (ips.length === 0) {
      disp.textContent = '⚠ No network IP found — are you on WiFi?';
      disp.style.color = 'var(--accent-r)';
      box.style.display = 'block';
    } else {
      window._lanIP    = ips[0];
      window._sslPort  = sslPort;
      disp.innerHTML = ips.map((ip, i) => {
        const url = `https://${ip}:${sslPort}`;
        const label = i === 0 ? '✓ ' : '  ';
        return `<div style="padding:3px 0;cursor:pointer" data-url="${url}">${label}${url}</div>`;
      }).join('');
      // Tap any IP line to set it as the active one
      disp.addEventListener('click', (e) => {
        const row = e.target.closest('[data-url]');
        if (!row) return;
        const chosenURL = row.dataset.url;
        const chosenIP  = new URL(chosenURL).hostname;
        window._lanIP   = chosenIP;
        joinURL = `${chosenURL}/?room=${roomId}`;
        buildQR(joinURL);
        // Mark selected
        disp.querySelectorAll('[data-url]').forEach(r => r.textContent = '  ' + r.dataset.url);
        row.textContent = '✓ ' + chosenURL;
        copyToClipboard(joinURL, 'Link copied!');
      });
      box.style.display = 'block';
    }
  })
  .catch(() => {})
  .finally(() => connectWS());
