const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// rooms: Map<roomId, { viewer: ws, cameras: Map<cameraId, ws> }>
const rooms = new Map();

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function roomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function handle(ws, msg) {
  switch (msg.type) {

    case 'create-room': {
      // Clean up any existing room this viewer had
      if (ws.roomId) {
        const old = rooms.get(ws.roomId);
        if (old && old.viewer === ws) rooms.delete(ws.roomId);
      }
      const id = roomCode();
      rooms.set(id, { viewer: ws, cameras: new Map() });
      ws.roomId = id;
      ws.role = 'viewer';
      send(ws, { type: 'room-created', roomId: id });
      break;
    }

    case 'join-room': {
      const roomId = (msg.roomId || '').toUpperCase().trim();
      const room = rooms.get(roomId);
      if (!room) {
        send(ws, { type: 'error', code: 'NO_ROOM', message: 'Room not found. Check the code and try again.' });
        return;
      }
      ws.roomId = roomId;
      ws.role = 'camera';
      ws.cameraName = (msg.cameraName || '').trim() || `Camera ${room.cameras.size + 1}`;
      room.cameras.set(ws.id, ws);
      send(ws, { type: 'joined', cameraId: ws.id, cameraName: ws.cameraName });
      send(room.viewer, { type: 'camera-joined', cameraId: ws.id, cameraName: ws.cameraName });
      break;
    }

    // WebRTC signaling – relay between camera and viewer
    case 'offer':
    case 'answer':
    case 'ice-candidate': {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (ws.role === 'camera') {
        send(room.viewer, { ...msg, cameraId: ws.id });
      } else if (ws.role === 'viewer') {
        const cam = room.cameras.get(msg.cameraId);
        send(cam, msg);
      }
      break;
    }

    // Viewer sending commands to a camera (switch cam, mute, quality, torch)
    case 'camera-command': {
      const room = rooms.get(ws.roomId);
      if (!room || ws.role !== 'viewer') return;
      const cam = room.cameras.get(msg.cameraId);
      send(cam, msg);
      break;
    }

    // Camera sending status updates to viewer (facingMode, muted, torch, quality)
    case 'camera-status': {
      const room = rooms.get(ws.roomId);
      if (!room || ws.role !== 'camera') return;
      send(room.viewer, { ...msg, cameraId: ws.id });
      break;
    }

    // Camera pinging to keep connection alive / show latency
    case 'ping': {
      send(ws, { type: 'pong', ts: msg.ts });
      break;
    }
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

wss.on('connection', (ws) => {
  ws.id = uid();
  ws.alive = true;

  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handle(ws, msg);
  });
  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));
});

// Heartbeat – terminate dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) { ws.terminate(); return; }
    ws.alive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CamNet running → http://localhost:${PORT}`);
});
