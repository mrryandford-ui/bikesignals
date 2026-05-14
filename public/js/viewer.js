'use strict';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// ── State ──────────────────────────────────────────────────────
let ws = null;
let roomId = null;
let joinURL = null; // full URL camera phones should open (uses LAN IP, not localhost)
const peers = new Map(); // cameraId → { pc, name, stream, recorder, motion, ... }

let globalMotion = false;
let motionSens = 'mid';
let muteAll = false;
let mirrorFront = true;
let currentLayout = 'l-auto';

// ── Motion detection sensitivity thresholds ────────────────────
const SENS = {
  low:  { pixelDiff: 35, fraction: 0.04 },
  mid:  { pixelDiff: 25, fraction: 0.025 },
  high: { pixelDiff: 15, fraction: 0.01 },
};

// ── WebSocket ──────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    setWsStatus('connected');
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
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Prepare to receive video+audio
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = (e) => {
    const peer = peers.get(cameraId);
    if (!peer) return;
    if (!peer.stream) peer.stream = e.streams[0];
    else e.streams[0].getTracks().forEach(t => peer.stream.addTrack(t));
    attachStream(cameraId, e.streams[0]);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'ice-candidate', cameraId, candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => updateConnState(cameraId, pc.connectionState);
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') pc.restartIce();
  };

  peers.set(cameraId, { pc, name, stream: null, recorder: null, motion: null, facingMode: null, torchOn: false, quality: 720, recordTarget: null, recDurationMs: 0, recStartTime: 0, recSegNum: 0, recBaseName: '', recChunks: [], recSegTimer: null, recDurationTimer: null });
  addCameraCard(cameraId, name);
  updateCamCount();
}

function onCameraLeft(cameraId) {
  const peer = peers.get(cameraId);
  if (peer) {
    stopMotion(cameraId);
    stopRecording(cameraId);
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
  if (!peers.has(cameraId)) onCameraJoined(cameraId, `Camera ${peers.size + 1}`);
  const peer = peers.get(cameraId);
  await peer.pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  wsSend({ type: 'answer', cameraId, sdp: answer.sdp });
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

function onCameraStatus({ cameraId, facingMode, muted, torch, quality: q }) {
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
  if (globalMotion) startMotion(cameraId);
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
    </div>
    <div class="cam-controls">
      <button class="icon-btn" data-action="fullscreen"  title="Fullscreen">⛶</button>
      <button class="icon-btn" data-action="snapshot"    title="Snapshot">📸</button>
      <button class="icon-btn" data-action="record"      title="Record">⏺</button>
      <button class="icon-btn" data-action="mute"        title="Mute">🔊</button>
      <button class="icon-btn" data-action="nightvision" title="Night vision">🌙</button>
      <button class="icon-btn" data-action="motion"      title="Motion detect">👁</button>
      <button class="icon-btn" data-action="flip"        title="Flip camera (remote)">🔄</button>
      <button class="icon-btn" data-action="flash"       title="Toggle flash (remote)">🔦</button>
      <button class="icon-btn" data-action="stealth"     title="Stealth mode (remote)">🕵️</button>
      <button class="icon-btn" data-action="quality"     title="Quality: 720p">🎞️</button>
      <button class="icon-btn" data-action="rename"      title="Rename">✏️</button>
      <button class="icon-btn danger" data-action="disconnect" title="Disconnect">✕</button>
    </div>
  `;

  // Touch: tap to toggle controls visibility on mobile
  card.addEventListener('click', (e) => {
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
      break;
    }

    case 'nightvision':
      video.classList.toggle('night');
      btn.classList.toggle('active', video.classList.contains('night'));
      break;

    case 'motion':
      if (peer.motion) { stopMotion(cameraId); btn.classList.remove('active'); }
      else              { startMotion(cameraId); btn.classList.add('active'); }
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
      break;

    case 'flash': {
      if (peer.facingMode === 'user') break; // front camera has no flash
      peer.torchOn = !peer.torchOn;
      wsSend({ type: 'camera-command', cameraId, command: 'torch-toggle' });
      btn.classList.toggle('active', peer.torchOn);
      showToast(peer.torchOn ? '🔦 Flash on' : '🔦 Flash off');
      break;
    }

    case 'stealth':
      wsSend({ type: 'camera-command', cameraId, command: 'stealth' });
      btn.classList.add('active');
      setTimeout(() => btn.classList.remove('active'), 1500);
      showToast(`Stealth sent to ${peer.name}`);
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
function toggleFullscreen(cameraId) {
  const card = document.getElementById(`card-${cameraId}`);
  if (!card) return;
  if (!document.fullscreenElement) {
    (card.requestFullscreen || card.webkitRequestFullscreen).call(card);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}

// ── Snapshot ───────────────────────────────────────────────────
function takeSnapshot(cameraId) {
  const video = document.querySelector(`#card-${cameraId} .cam-video`);
  if (!video || !video.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (video.classList.contains('mirror')) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0);

  const peer     = peers.get(cameraId);
  const name     = (peer?.name || cameraId).replace(/\s+/g, '-');
  const filename = `camnet-${name}-${Date.now()}.jpg`;
  const dataUrl  = canvas.toDataURL('image/jpeg', 0.92);

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
        const blob = new Blob(peer.recChunks, { type: rec.mimeType });
        peer.recChunks = [];
        const ext    = rec.mimeType.includes('mp4') ? 'mp4' : 'webm';
        const suffix = multiSegment ? `_part${String(peer.recSegNum + 1).padStart(2,'0')}` : '';
        const filename = `${peer.recBaseName}${suffix}.${ext}`;
        peer.recSegNum++;
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
let motionNotifEnabled = false;
let motionAutoSnap     = false;

function startMotion(cameraId) {
  const peer = peers.get(cameraId);
  const video = document.querySelector(`#card-${cameraId} .cam-video`);
  if (!peer || !video || peer.motion) return;

  // Request notification permission lazily on first motion enable
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(p => { motionNotifEnabled = p === 'granted'; });
  } else {
    motionNotifEnabled = Notification.permission === 'granted';
  }

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
      let changed = 0;
      for (let i = 0; i < frame.length; i += 4) {
        const d = (Math.abs(frame[i]-prev[i]) + Math.abs(frame[i+1]-prev[i+1]) + Math.abs(frame[i+2]-prev[i+2])) / 3;
        if (d > pixelDiff) changed++;
      }
      if (changed / (W * H) > fraction) {
        showMotionAlert(cameraId);
        clearTimeout(alertTimeout);
        alertTimeout = setTimeout(() => hideMotionAlert(cameraId), 3000);
      }
    }
    prev = frame.slice();
    setTimeout(analyze, 400); // ~2.5 fps analysis
  }

  peer.motion = { stop: () => { running = false; canvas.remove(); clearTimeout(alertTimeout); } };
  analyze();
}

function stopMotion(cameraId) {
  const peer = peers.get(cameraId);
  if (!peer?.motion) return;
  peer.motion.stop();
  peer.motion = null;
  hideMotionAlert(cameraId);
}

function showMotionAlert(cameraId) {
  const card = document.getElementById(`card-${cameraId}`);
  if (!card) return;
  let al = card.querySelector('.motion-alert');
  if (!al) {
    al = document.createElement('div');
    al.className = 'motion-alert';
    al.textContent = '⚠ Motion';
    card.appendChild(al);
  }
  if (!al.classList.contains('visible')) {
    al.classList.add('visible');
    const peer = peers.get(cameraId);
    // Browser notification (only when page is hidden or user opted in)
    if (motionNotifEnabled) {
      new Notification(`Motion – ${peer?.name || cameraId}`, {
        body: new Date().toLocaleTimeString(),
        icon: '/icons/icon-192.png',
        tag: `motion-${cameraId}`,
        silent: false,
      });
    }
    // Auto-snapshot if enabled
    if (motionAutoSnap) takeSnapshot(cameraId);
  }
}

function hideMotionAlert(cameraId) {
  document.querySelector(`#card-${cameraId} .motion-alert`)?.classList.remove('visible');
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
document.getElementById('settingsBtn').addEventListener('click',() => openPanel('settingsPanel'));

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
  closePanel('layoutPanel');
});

// Session panel actions
document.getElementById('copyCodeBtn').addEventListener('click',    () => copyToClipboard(roomId, 'Code copied!'));
document.getElementById('copyLinkBtn').addEventListener('click',    () => copyToClipboard(joinURL, 'Link copied!'));
document.getElementById('panelCopyCode').addEventListener('click',  () => copyToClipboard(roomId, 'Code copied!'));
document.getElementById('panelCopyLink').addEventListener('click',  () => copyToClipboard(joinURL, 'Link copied!'));
document.getElementById('newSessionBtn').addEventListener('click',  () => {
  closePanel('sessionPanel');
  wsSend({ type: 'create-room' });
  peers.forEach((_, id) => onCameraLeft(id));
});

// Settings toggles
document.getElementById('globalMotionToggle').addEventListener('click', function() {
  globalMotion = !globalMotion;
  this.classList.toggle('on', globalMotion);
  peers.forEach((_, id) => {
    if (globalMotion) startMotion(id);
    else              stopMotion(id);
  });
});

document.getElementById('muteAllToggle').addEventListener('click', function() {
  muteAll = !muteAll;
  this.classList.toggle('on', muteAll);
  document.querySelectorAll('.cam-video').forEach(v => v.muted = muteAll);
});

document.getElementById('mirrorToggle').addEventListener('click', function() {
  mirrorFront = !mirrorFront;
  this.classList.toggle('on', mirrorFront);
  peers.forEach((_, id) => applyMirror(id));
});

document.getElementById('motionAutoSnapToggle').addEventListener('click', function() {
  motionAutoSnap = !motionAutoSnap;
  this.classList.toggle('on', motionAutoSnap);
});

document.getElementById('motionSensSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sens]');
  if (!btn) return;
  document.querySelectorAll('#motionSensSeg .seg-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  motionSens = btn.dataset.sens;
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
setInterval(() => wsSend({ type: 'ping', ts: Date.now() }), 5000);

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
