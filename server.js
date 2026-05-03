'use strict';

const express    = require('express');
const { WebSocketServer } = require('ws');
const https      = require('https');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');
const selfsigned = require('selfsigned');
const os         = require('os');

// ── TLS cert (generated once, reused forever) ──────────────────
const CERT_DIR  = path.join(__dirname, '.certs');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE  = path.join(CERT_DIR, 'key.pem');

async function getCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
  }

  console.log('Generating self-signed certificate (one-time)…');
  fs.mkdirSync(CERT_DIR, { recursive: true });

  const localIPs = getLocalIPs();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...localIPs.map(ip => ({ type: 7, ip })),
  ];

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'CamNet' }], {
    days: 3650,
    extensions: [{ name: 'subjectAltName', altNames }],
  });

  fs.writeFileSync(CERT_FILE, pems.cert,    { mode: 0o600 });
  fs.writeFileSync(KEY_FILE,  pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private };
}

// ── Room state ─────────────────────────────────────────────────
const rooms = new Map();

function uid() { return Math.random().toString(36).slice(2, 10); }

function roomCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function handle(ws, msg) {
  switch (msg.type) {

    case 'create-room': {
      if (ws.roomId) {
        const old = rooms.get(ws.roomId);
        if (old && old.viewer === ws) rooms.delete(ws.roomId);
      }
      const id = roomCode();
      rooms.set(id, { viewer: ws, cameras: new Map(), _cleanupTimer: null });
      ws.roomId = id;
      ws.role   = 'viewer';
      send(ws, { type: 'room-created', roomId: id, lanIP: getLocalIPs()[0] || null });
      break;
    }

    // Viewer reconnecting after a tab-switch / brief disconnect — reattach to existing room
    case 'rejoin-room': {
      const roomId = (msg.roomId || '').toUpperCase().trim();
      const room   = rooms.get(roomId);
      if (!room) {
        // Room already expired — treat as a fresh create
        const id = roomCode();
        rooms.set(id, { viewer: ws, cameras: new Map(), _cleanupTimer: null });
        ws.roomId = id;
        ws.role   = 'viewer';
        send(ws, { type: 'room-created', roomId: id, lanIP: getLocalIPs()[0] || null });
        return;
      }
      clearTimeout(room._cleanupTimer);
      room._cleanupTimer = null;
      room.viewer = ws;
      ws.roomId   = roomId;
      ws.role     = 'viewer';
      send(ws, { type: 'room-rejoined', roomId });
      // Tell cameras viewer is back — they will re-send their offers
      room.cameras.forEach(cam => send(cam, { type: 'viewer-reconnected' }));
      break;
    }

    case 'join-room': {
      const roomId = (msg.roomId || '').toUpperCase().trim();
      const room   = rooms.get(roomId);
      if (!room) {
        send(ws, { type: 'error', code: 'NO_ROOM', message: 'Room not found. Check the code and try again.' });
        return;
      }
      ws.roomId     = roomId;
      ws.role       = 'camera';
      ws.cameraName = (msg.cameraName || '').trim() || `Camera ${room.cameras.size + 1}`;
      room.cameras.set(ws.id, ws);
      send(ws,          { type: 'joined',        cameraId: ws.id, cameraName: ws.cameraName });
      send(room.viewer, { type: 'camera-joined', cameraId: ws.id, cameraName: ws.cameraName });
      break;
    }

    case 'offer':
    case 'answer':
    case 'ice-candidate': {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (ws.role === 'camera') {
        send(room.viewer, { ...msg, cameraId: ws.id });
      } else if (ws.role === 'viewer') {
        send(room.cameras.get(msg.cameraId), msg);
      }
      break;
    }

    case 'camera-command': {
      const room = rooms.get(ws.roomId);
      if (!room || ws.role !== 'viewer') return;
      send(room.cameras.get(msg.cameraId), msg);
      break;
    }

    case 'camera-status': {
      const room = rooms.get(ws.roomId);
      if (!room || ws.role !== 'camera') return;
      send(room.viewer, { ...msg, cameraId: ws.id });
      break;
    }

    case 'ping':
      send(ws, { type: 'pong', ts: msg.ts });
      break;
  }
}

function cleanup(ws) {
  if (!ws.roomId) return;
  const room = rooms.get(ws.roomId);
  if (!room) return;
  if (ws.role === 'viewer') {
    // Grace period: give the viewer 25 s to reconnect before telling cameras and deleting
    room._cleanupTimer = setTimeout(() => {
      if (rooms.get(ws.roomId) === room) {
        room.cameras.forEach(cam => send(cam, { type: 'viewer-disconnected' }));
        rooms.delete(ws.roomId);
      }
    }, 25_000);
  } else if (ws.role === 'camera') {
    room.cameras.delete(ws.id);
    send(room.viewer, { type: 'camera-left', cameraId: ws.id });
  }
}

// ── Helpers ────────────────────────────────────────────────────
function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const all = Object.entries(ifaces)
    .flatMap(([name, addrs]) => (addrs || []).map(a => ({ ...a, name })))
    .filter(i => !i.internal && i.family === 'IPv4');

  // Prefer WiFi (wlan0 on Android/Linux, en0/en1 on Mac)
  // Private ranges: 192.168.x.x, 10.x.x.x, 172.16-31.x.x
  const isPrivate = ip =>
    /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

  const wifi   = all.filter(i => /wlan|en[0-9]|wifi/i.test(i.name) && isPrivate(i.address));
  const priv   = all.filter(i => isPrivate(i.address));
  const chosen = wifi.length ? wifi : priv.length ? priv : all;
  return [...new Set(chosen.map(i => i.address))];
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const tls  = await getCert();
  const app  = express();

  // Never cache this — viewer.js fetches it to get the real LAN IP
  app.get('/api/info', (req, res) => {
    const allIPs = Object.entries(os.networkInterfaces())
      .flatMap(([name, addrs]) => (addrs || []).map(a => ({ name, address: a.address, internal: a.internal, family: a.family })))
      .filter(i => !i.internal && i.family === 'IPv4');
    const lanIP = getLocalIPs()[0] || null;
    res.json({ lanIP, allIPs });
  });

  // Never cache JS/HTML — WebViews and browsers always get fresh files
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (/\.(js|html)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  }));

  const server = https.createServer(tls, app);
  const wss    = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.id    = uid();
    ws.alive = true;
    ws.on('pong',    ()    => { ws.alive = true; });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      handle(ws, msg);
    });
    ws.on('close', () => cleanup(ws));
    ws.on('error', () => cleanup(ws));
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.alive) { ws.terminate(); return; }
      ws.alive = false;
      ws.ping();
    });
  }, 30000);
  wss.on('close', () => clearInterval(heartbeat));

  const PORT = parseInt(process.env.PORT || '3000', 10);

  server.listen(PORT, () => {
    const ips = getLocalIPs();
    const shareURL = ips.length ? `https://${ips[0]}:${PORT}` : null;

    console.log('\n┌─────────────────────────────────────────────┐');
    console.log('│              CamNet is running              │');
    console.log('├─────────────────────────────────────────────┤');
    console.log('│                                             │');
    if (shareURL) {
      console.log('│  ALL PHONES use this URL:                   │');
      console.log('│  ' + shareURL.padEnd(43) + '│');
      console.log('│                                             │');
      console.log('│  Server phone  → choose Monitor             │');
      console.log('│  Camera phones → choose Camera              │');
    } else {
      console.log('│  ⚠  No WiFi IP found — connect to WiFi      │');
      console.log('│  Then restart: npm start                    │');
    }
    console.log('│                                             │');
    console.log('│  First visit on each phone:                 │');
    console.log('│  tap Advanced → Proceed  (once only)        │');
    console.log('│                                             │');
    console.log('└─────────────────────────────────────────────┘\n');
  });

  // HTTP → HTTPS redirect (best-effort, ignore if port is taken)
  http.createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
    res.end();
  }).listen(PORT + 1).on('error', () => {});
}

main().catch(err => { console.error(err); process.exit(1); });
