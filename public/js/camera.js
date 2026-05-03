'use strict';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const QUALITY = {
  240:  { width: 426,  height: 240,  frameRate: 15, bitrate: 300_000  },
  480:  { width: 854,  height: 480,  frameRate: 24, bitrate: 800_000  },
  720:  { width: 1280, height: 720,  frameRate: 30, bitrate: 1_500_000 },
  1080: { width: 1920, height: 1080, frameRate: 30, bitrate: 3_000_000 },
};

// ── State ──────────────────────────────────────────────────────
let ws         = null;
let pc         = null;
let localStream = null;
let cameraId   = null;
let roomId     = null;
let cameraName = null;
let facingMode = 'environment'; // rear camera default
let micEnabled = true;
let torchOn    = false;
let quality    = 720;
let wakeLock   = null;
let wsOpen     = false;

// ── Pre-fill room code from URL param ──────────────────────────
const params = new URLSearchParams(location.search);
if (params.get('room')) {
  document.getElementById('codeInput').value = params.get('room').toUpperCase();
}

// ── Join button ────────────────────────────────────────────────
document.getElementById('joinBtn').addEventListener('click', startJoin);
document.getElementById('codeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startJoin();
});
document.getElementById('nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startJoin();
});

async function startJoin() {
  const code = document.getElementById('codeInput').value.trim().toUpperCase();
  if (code.length !== 6) { showError('Enter the 6-character session code'); return; }
  cameraName = document.getElementById('nameInput').value.trim() || null;
  hideError();
  setJoinLoading(true);
  roomId = code;
  // Create AudioContext here — must be inside a user gesture
  _initAudioCtx();
  try {
    await initMedia();
    connectWS();
  } catch (e) {
    setJoinLoading(false);
    showError(e.message || 'Could not access camera. Check permissions.');
  }
}

// ── Media ──────────────────────────────────────────────────────
async function initMedia() {
  const q = QUALITY[quality];
  const video = {
    facingMode: { ideal: facingMode },
    width:      { ideal: q.width },
    height:     { ideal: q.height },
    frameRate:  { ideal: q.frameRate },
  };
  const audio = { echoCancellation: true, noiseSuppression: true };

  if (localStream) localStream.getTracks().forEach(t => t.stop());

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch {
    try {
      // Specific constraints rejected — try basic audio (device chooses format)
      localStream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
    } catch {
      // No mic at all — stream video only
      localStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      micEnabled = false;
      showToast('Mic unavailable — video only');
    }
  }

  const vid = document.getElementById('localVideo');
  vid.srcObject = localStream;
  vid.classList.toggle('mirror', facingMode === 'user');

  sendStatus();
}

// ── WebSocket ──────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    wsOpen = true;
    ws.send(JSON.stringify({
      type: 'join-room',
      roomId,
      cameraName: cameraName || undefined,
    }));
  };

  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    onMessage(msg);
  };

  ws.onclose = () => {
    wsOpen = false;
    setConnStatus('disconnected', 'Reconnecting…');
    if (localStream) setTimeout(connectWS, 3000);
  };

  ws.onerror = () => ws.close();
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Message handler ────────────────────────────────────────────
async function onMessage(msg) {
  switch (msg.type) {
    case 'joined':
      cameraId = msg.cameraId;
      setConnStatus('connecting', 'Waiting for viewer…');
      showLiveScreen();
      await requestWakeLock();
      await createPeer();
      break;

    case 'answer':
      await handleAnswer(msg);
      break;

    case 'ice-candidate':
      await handleIce(msg);
      break;

    case 'camera-command':
      await handleCommand(msg);
      break;

    case 'viewer-disconnected':
      setConnStatus('disconnected', 'Viewer disconnected');
      closePeer();
      break;

    case 'error':
      showError(msg.message || 'Connection error');
      setJoinLoading(false);
      break;
  }
}

// ── WebRTC ─────────────────────────────────────────────────────
async function createPeer() {
  closePeer();
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Add all media tracks
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'ice-candidate', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    switch (pc.connectionState) {
      case 'connected':    setConnStatus('connected', 'Streaming'); applyBitrate(); break;
      case 'disconnected': setConnStatus('disconnected', 'Reconnecting…'); break;
      case 'failed':       pc.restartIce(); break;
    }
  };

  const offer = await pc.createOffer({
    offerToReceiveAudio: false,
    offerToReceiveVideo: false,
  });
  await pc.setLocalDescription(offer);
  wsSend({ type: 'offer', sdp: offer.sdp });
}

async function handleAnswer({ sdp }) {
  if (!pc || pc.signalingState === 'stable') return;
  await pc.setRemoteDescription({ type: 'answer', sdp });
}

async function handleIce({ candidate }) {
  if (!pc || !candidate) return;
  try { await pc.addIceCandidate(candidate); } catch {}
}

function closePeer() {
  if (pc) { pc.close(); pc = null; }
}

// ── Bitrate control ────────────────────────────────────────────
async function applyBitrate() {
  if (!pc) return;
  const { bitrate } = QUALITY[quality];
  const senders = pc.getSenders().filter(s => s.track?.kind === 'video');
  for (const sender of senders) {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = bitrate;
    await sender.setParameters(params).catch(() => {});
  }
}

// ── Commands from viewer ───────────────────────────────────────
async function handleCommand({ command, value }) {
  switch (command) {
    case 'flip':
      await flipCamera();
      break;
    case 'mute':
      setMic(false);
      break;
    case 'unmute':
      setMic(true);
      break;
    case 'disconnect':
      hangup();
      break;
  }
}

// ── Camera flip ────────────────────────────────────────────────
async function flipCamera() {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  document.getElementById('flipBtn').classList.toggle('active', facingMode === 'user');

  try {
    await initMedia();
    // Replace video track in existing peer connection
    if (pc) {
      const newTrack = localStream.getVideoTracks()[0];
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender && newTrack) await sender.replaceTrack(newTrack);
    }
    sendStatus();
  } catch (e) {
    console.warn('Flip failed:', e);
  }
}

// ── Mic toggle ─────────────────────────────────────────────────
function setMic(enabled) {
  micEnabled = enabled;
  localStream?.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  const btn = document.getElementById('micBtn');
  btn.classList.toggle('muted', !micEnabled);
  btn.querySelector('div').textContent = micEnabled ? '🎙️' : '🔇';
  btn.querySelector('span').textContent = micEnabled ? 'Mic' : 'Muted';
  sendStatus();
}

document.getElementById('micBtn').addEventListener('click', () => setMic(!micEnabled));

// ── Torch ──────────────────────────────────────────────────────
async function setTorch(on) {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    torchOn = on;
    document.getElementById('torchBtn').classList.toggle('active', on);
  } catch {
    showToast('Torch not available on this device');
  }
}

document.getElementById('torchBtn').addEventListener('click', () => setTorch(!torchOn));

// ── Quality ────────────────────────────────────────────────────
document.getElementById('qualityBtn').addEventListener('click', () => {
  document.getElementById('qualityPanel').classList.remove('hidden');
});
document.getElementById('qualityBackdrop').addEventListener('click', () => {
  document.getElementById('qualityPanel').classList.add('hidden');
});

document.getElementById('qualityList').addEventListener('click', async (e) => {
  const item = e.target.closest('[data-q]');
  if (!item) return;
  const q = parseInt(item.dataset.q, 10);
  document.querySelectorAll('.quality-item').forEach(i => i.classList.remove('selected'));
  item.classList.add('selected');
  quality = q;
  document.getElementById('qualityLabel').textContent = `${q}p`;
  document.getElementById('qualityPanel').classList.add('hidden');
  try {
    await initMedia();
    if (pc) {
      const newTrack = localStream.getVideoTracks()[0];
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender && newTrack) await sender.replaceTrack(newTrack);
      applyBitrate();
    }
  } catch (e) {
    console.warn('Quality change failed:', e);
  }
});

// ── Flip button ────────────────────────────────────────────────
document.getElementById('flipBtn').addEventListener('click', flipCamera);

// ── Hangup ─────────────────────────────────────────────────────
document.getElementById('hangupBtn').addEventListener('click', hangup);

function hangup() {
  exitStealth();
  closePeer();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  stopKeepAlive();
  ws?.close();
  // Native app: stop foreground service
  window.AndroidBridge?.stopStreaming();
  showSetupScreen();
}

// ── Status ─────────────────────────────────────────────────────
function setConnStatus(state, text) {
  const dot  = document.getElementById('connDot');
  const span = document.getElementById('connText');
  dot.className  = 'dot ' + state;
  span.textContent = text;
}

function sendStatus() {
  wsSend({
    type: 'camera-status',
    facingMode,
    muted: !micEnabled,
    torch: torchOn,
  });
}

// ── Screen / UI state ──────────────────────────────────────────
function showLiveScreen() {
  document.getElementById('setupScreen').classList.add('hidden');
  document.getElementById('liveScreen').classList.remove('hidden');
  document.getElementById('liveRoomCode').textContent = roomId;
  setJoinLoading(false);
  startKeepAlive();
  // Native app: start foreground service so camera stays alive with screen off
  window.AndroidBridge?.startStreaming();
}

function showSetupScreen() {
  document.getElementById('liveScreen').classList.add('hidden');
  document.getElementById('setupScreen').classList.remove('hidden');
  setConnStatus('disconnected', 'Disconnected');
}

// ── Native: long-press session code → reset server URL ─────────
if (window.AndroidBridge) {
  let _lpTimer = null;
  const codeEl = document.getElementById('liveRoomCode');
  codeEl.addEventListener('touchstart', () => {
    _lpTimer = setTimeout(() => {
      window.AndroidBridge.resetServer();
    }, 1500);
  });
  codeEl.addEventListener('touchend',   () => clearTimeout(_lpTimer));
  codeEl.addEventListener('touchmove',  () => clearTimeout(_lpTimer));
}

function setJoinLoading(loading) {
  const btn = document.getElementById('joinBtn');
  btn.disabled = loading;
  btn.textContent = loading ? 'Connecting…' : 'Join →';
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.classList.add('show');
}
function hideError() {
  document.getElementById('errorMsg').classList.remove('show');
}

// ── Keep-alive: route silent audio through <audio> element so   ──
// ── Android grants audio focus and won't suspend the tab        ──
let _audioCtx      = null;
let _keepAliveAudio = null;

function _initAudioCtx() {
  if (_audioCtx) return;
  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    _audioCtx.resume().catch(() => {});
  } catch (e) {}
}

function startKeepAlive() {
  if (_keepAliveAudio) return;
  try {
    _initAudioCtx();
    if (!_audioCtx) return;

    const osc  = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    gain.gain.value = 0.001;

    // Route to a MediaStream → <audio> element so Android gives us audio focus
    const dest = _audioCtx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();

    _keepAliveAudio = new Audio();
    _keepAliveAudio.srcObject = dest.stream;
    _keepAliveAudio.volume    = 0.001;
    _keepAliveAudio.play().catch(() => {});

    // Tell Android OS this is intentional media — prevents tab suspension
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'CamNet Camera',
        artist: 'Streaming…',
      });
      navigator.mediaSession.playbackState = 'playing';
    }
  } catch (e) {
    console.warn('Keep-alive failed:', e);
  }
}

function stopKeepAlive() {
  if (_keepAliveAudio) {
    _keepAliveAudio.pause();
    _keepAliveAudio.srcObject = null;
    _keepAliveAudio = null;
  }
  if (_audioCtx) {
    _audioCtx.close().catch(() => {});
    _audioCtx = null;
  }
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'none';
  }
}

// ── Wake Lock ──────────────────────────────────────────────────
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) {
    console.warn('Wake lock failed:', e);
  }
}

// ── Stealth mode ───────────────────────────────────────────────
// Wake Lock keeps the screen physically on; black overlay makes it look off.
// The tab stays foreground, the camera keeps streaming continuously.
let stealthTapCount = 0;
let stealthTapTimer = null;

document.getElementById('stealthBtn').addEventListener('click', enterStealth);

async function enterStealth() {
  document.getElementById('stealthOverlay').style.display = 'block';
  if (!wakeLock) await requestWakeLock();
}

function exitStealth() {
  stealthTapCount = 0;
  clearTimeout(stealthTapTimer);
  document.getElementById('stealthOverlay').style.display = 'none';
}

document.getElementById('stealthOverlay').addEventListener('click', () => {
  stealthTapCount++;
  clearTimeout(stealthTapTimer);

  const hint = document.getElementById('stealthTapHint');
  hint.style.color = '#444';
  setTimeout(() => { hint.style.color = '#111'; }, 300);

  if (stealthTapCount >= 3) {
    exitStealth();
  } else {
    stealthTapTimer = setTimeout(() => { stealthTapCount = 0; }, 2000);
  }
});

// ── Visibility change — wake lock + stream recovery ────────────
// If the physical power button is pressed while NOT in stealth, the OS may
// kill camera access. On return, reacquire the wake lock and restart the
// camera track if the OS ended it.
document.addEventListener('visibilitychange', async () => {
  if (!localStream || document.visibilityState !== 'visible') return;
  if (!wakeLock) await requestWakeLock();
  if (_audioCtx?.state === 'suspended') _audioCtx.resume().catch(() => {});
  if (_keepAliveAudio?.paused)          _keepAliveAudio.play().catch(() => {});
  const vTrack = localStream.getVideoTracks()[0];
  if (vTrack && vTrack.readyState === 'ended') {
    try {
      await initMedia();
      if (pc) {
        const newV = localStream.getVideoTracks()[0];
        const newA = localStream.getAudioTracks()[0];
        for (const sender of pc.getSenders()) {
          if (sender.track?.kind === 'video' && newV) await sender.replaceTrack(newV).catch(() => {});
          if (sender.track?.kind === 'audio' && newA) await sender.replaceTrack(newA).catch(() => {});
        }
        localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
      }
    } catch (e) {
      console.warn('Camera recovery failed:', e);
    }
  }
});

// ── Toast ──────────────────────────────────────────────────────
function showToast(msg) {
  let t = document.getElementById('_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '_toast';
    t.style.cssText = 'position:fixed;bottom:160px;left:50%;transform:translateX(-50%);background:rgba(255,255,255,0.12);backdrop-filter:blur(10px);color:#fff;padding:10px 20px;border-radius:30px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none;transition:opacity 0.3s';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.style.opacity = '0', 2500);
}
