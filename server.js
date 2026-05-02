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
      rooms.set(id, { viewer: ws, cameras: new Map() });
      ws.roomId = id;
      ws.role   = 'viewer';
      send(ws, { type: 'room-created', roomId: id });
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
    room.cameras.forEach(cam => send(cam, { type: 'viewer-disconnected' }));
    rooms.delete(ws.roomId);
  } else if (ws.role === 'camera') {
    room.cameras.delete(ws.id);
    send(room.viewer, { type: 'camera-left', cameraId: ws.id });
  }
}

// ── Helpers ────────────────────────────────────────────────────
function getLocalIPs() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && !i.internal && i.family === 'IPv4')
    .map(i => i.address);
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const tls  = await getCert();
  const app  = express();
  app.use(express.static(path.join(__dirname, 'public')));

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
    console.log('\n  CamNet is running\n');
    console.log(`  This machine:  https://localhost:${PORT}`);
    ips.forEach(ip => console.log(`  Other devices: https://${ip}:${PORT}`));
    console.log('\n  On each phone: open the URL above → tap Advanced → Proceed (once only)\n');
  });

  // HTTP → HTTPS redirect (best-effort, ignore if port is taken)
  http.createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
    res.end();
  }).listen(PORT + 1).on('error', () => {});
}

main().catch(err => { console.error(err); process.exit(1); });
