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
    ws.send(JSON.stringify({ type: 'create-room' }));
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
    case 'room-created':   onRoomCreated(msg.roomId); break;
    case 'camera-joined':  onCameraJoined(msg.cameraId, msg.cameraName); break;
    case 'camera-left':    onCameraLeft(msg.cameraId);           break;
    case 'offer':          await handleOffer(msg);               break;
    case 'ice-candidate':  await handleIce(msg);                 break;
    case 'camera-status':  onCameraStatus(msg);                  break;
    case 'pong':           onPong(msg);                          break;
  }
}

// ── Room created ───────────────────────────────────────────────
function onRoomCreated(id) {
  roomId = id;
  const port = location.port ? `:${location.port}` : '';
  const ip   = window._lanIP;
  const base = ip ? `${location.protocol}//${ip}${port}` : location.origin;
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

  peers.set(cameraId, { pc, name, stream: null, recorder: null, motion: null, facingMode: null });
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
  const peer = peers.get(cameraId);
  if (!peer) return;
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

function onCameraStatus({ cameraId, facingMode, muted, torch }) {
  const peer = peers.get(cameraId);
  if (!peer) return;
  if (facingMode !== undefined) {
    peer.facingMode = facingMode;
    applyMirror(cameraId);
  }
  if (muted !== undefined) {
    const btn = document.querySelector(`#card-${cameraId} [data-action="mute"]`);
    if (btn) btn.title = muted ? 'Unmute' : 'Mute';
  }
}

function onPong({ ts }) {
  const latency = Date.now() - ts;
  document.querySelectorAll('.latency-badge').forEach(el => {
    el.textContent = `${latency}ms`;
  });
}

// ── Stream attachment ──────────────────────────────────────────
function attachStream(cameraId, stream) {
  const video = document.querySelector(`#card-${cameraId} .cam-video`);
  if (!video) return;
  video.srcObject = stream;
  video.muted = muteAll;
  video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
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
      <button class="icon-btn" data-action="fullscreen" title="Fullscreen">⛶</button>
      <button class="icon-btn" data-action="snapshot"   title="Snapshot">📸</button>
      <button class="icon-btn" data-action="mute"       title="Mute">🔊</button>
      <button class="icon-btn" data-action="nightvision" title="Night vision">🌙</button>
      <button class="icon-btn" data-action="motion"     title="Motion detect">👁</button>
      <button class="icon-btn" data-action="record"     title="Record">⏺</button>
      <button class="icon-btn" data-action="flip"       title="Flip camera">🔄</button>
      <button class="icon-btn" data-action="rename"     title="Rename">✏️</button>
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

function handleCardAction(cameraId, action, btn) {
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
      if (peer.recorder) { stopRecording(cameraId); btn.textContent = '⏺'; btn.classList.remove('active'); }
      else               { startRecording(cameraId); btn.textContent = '⏹'; btn.classList.add('active'); }
      break;

    case 'flip':
      wsSend({ type: 'camera-command', cameraId, command: 'flip' });
      btn.style.transform = 'rotate(180deg)';
      setTimeout(() => btn.style.transform = '', 400);
      break;

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
  const peer = peers.get(cameraId);
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/jpeg', 0.92);
  link.download = `snapshot-${(peer?.name || cameraId).replace(/\s+/g,'-')}-${Date.now()}.jpg`;
  link.click();
}

// ── Recording ──────────────────────────────────────────────────
function startRecording(cameraId) {
  const peer = peers.get(cameraId);
  if (!peer?.stream) return;
  const mimeType = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4']
    .find(m => MediaRecorder.isTypeSupported(m)) || '';
  try {
    const chunks = [];
    const rec = new MediaRecorder(peer.stream, mimeType ? { mimeType } : {});
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `camnet-${(peer.name || cameraId).replace(/\s+/g,'-')}-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };
    rec.start(1000);
    peer.recorder = rec;
    showRecIndicator(cameraId, true);
  } catch (e) {
    console.warn('Recording failed:', e);
  }
}

function stopRecording(cameraId) {
  const peer = peers.get(cameraId);
  if (!peer?.recorder) return;
  peer.recorder.stop();
  peer.recorder = null;
  showRecIndicator(cameraId, false);
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
function startMotion(cameraId) {
  const peer = peers.get(cameraId);
  const video = document.querySelector(`#card-${cameraId} .cam-video`);
  if (!peer || !video || peer.motion) return;

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
        alertTimeout = setTimeout(() => hideMotionAlert(cameraId), 2000);
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
    al.textContent = '⚠ Motion Detected';
    card.appendChild(al);
  }
  al.classList.remove('hidden');
}

function hideMotionAlert(cameraId) {
  document.querySelector(`#card-${cameraId} .motion-alert`)?.classList.add('hidden');
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

document.querySelectorAll('.panel-backdrop').forEach(bd => {
  bd.addEventListener('click', () => closePanel(bd.dataset.close));
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
    const port = location.port ? `:${location.port}` : '';
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
      window._lanIP = ips[0];
      disp.innerHTML = ips.map((ip, i) => {
        const url = `${location.protocol}//${ip}${port}`;
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
