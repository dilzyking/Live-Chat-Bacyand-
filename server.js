// server.js
// Real-time chat server. No database, no Firebase — everything lives in
// process memory and disappears when the server restarts (by design).

const express = require('express');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HISTORY_LIMIT = 100;       // messages kept per room, in memory only
const MAX_MSG_LEN = 2000;
const IDLE_TIMEOUT_MS = 35000;   // ping/pong dead-connection sweep

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;   // 2 MB decoded
const MAX_HISTORY_IMAGES = 10;             // only the newest N images stay in history (memory cap)
// base64 is ~4/3 larger than the raw file, plus room for JSON + caption
const MAX_PAYLOAD = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64 * 1024;

const IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,/;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).send('ok')); // for Render health checks

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD });

/**
 * rooms: Map<roomName, {
 *   clients: Map<ws, { id, name }>,
 *   history: Array<{ id, name, text, image?, imageExpired?, ts }>
 * }>
 * Nothing here ever touches disk.
 */
const rooms = new Map();

function getRoom(name) {
  if (!rooms.has(name)) {
    rooms.set(name, { clients: new Map(), history: [] });
  }
  return rooms.get(name);
}

function sanitize(str, max) {
  return String(str || '').slice(0, max).replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
}

// Check real file signature so a renamed .exe/.html can't pass as an image
function matchesMagic(type, buf) {
  if (type === 'png') return buf.length > 4 && buf.readUInt32BE(0) === 0x89504e47;
  if (type === 'jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (type === 'gif') return buf.length > 4 && buf.toString('ascii', 0, 4) === 'GIF8';
  if (type === 'webp') return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

// Returns the validated data URL, or null
function validateImage(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = IMAGE_RE.exec(dataUrl);
  if (!m) return null; // also rejects SVG (can contain scripts)
  const b64 = dataUrl.slice(m[0].length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
  if (!matchesMagic(m[1], buf)) return null;
  return dataUrl;
}

function broadcast(roomName, payload, exceptWs = null) {
  const room = rooms.get(roomName);
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const client of room.clients.keys()) {
    if (client !== exceptWs && client.readyState === client.OPEN) {
      client.send(data);
    }
  }
}

function userList(roomName) {
  const room = rooms.get(roomName);
  if (!room) return [];
  return [...room.clients.values()].map((u) => u.name);
}

function cleanupEmptyRoom(roomName) {
  const room = rooms.get(roomName);
  if (room && room.clients.size === 0) {
    rooms.delete(roomName); // history for an empty room is dropped too
  }
}

// Keep only the newest MAX_HISTORY_IMAGES images in a room's history.
// Older ones are replaced with a flag so the client can show "image expired".
function trimHistoryImages(room) {
  let count = 0;
  for (let i = room.history.length - 1; i >= 0; i--) {
    const m = room.history[i];
    if (m.image && ++count > MAX_HISTORY_IMAGES) {
      delete m.image;
      m.imageExpired = true;
    }
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomName = sanitize(url.searchParams.get('room') || 'general', 40) || 'general';
  const requestedName = sanitize(url.searchParams.get('name') || 'Guest', 24) || 'Guest';

  const room = getRoom(roomName);
  const id = crypto.randomUUID();

  // De-dupe display names within a room
  let name = requestedName;
  const taken = new Set(userList(roomName));
  let n = 2;
  while (taken.has(name)) {
    name = `${requestedName}(${n++})`;
  }

  room.clients.set(ws, { id, name });
  ws.isAlive = true;
  ws.roomName = roomName;

  ws.on('pong', () => { ws.isAlive = true; });

  // Send the new client its identity + recent history + who's online
  ws.send(JSON.stringify({ type: 'welcome', name, room: roomName, history: room.history }));
  ws.send(JSON.stringify({ type: 'presence', users: userList(roomName) }));

  // Tell everyone else someone joined
  broadcast(roomName, { type: 'system', text: `${name} joined`, ts: Date.now() }, ws);
  broadcast(roomName, { type: 'presence', users: userList(roomName) });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }

    if (msg.type === 'message' || msg.type === 'image') {
      const text = sanitize(msg.text, MAX_MSG_LEN).trim();
      let image = null;

      if (msg.type === 'image') {
        image = validateImage(msg.image);
        if (!image) {
          ws.send(JSON.stringify({
            type: 'error',
            text: 'Image rejected. Use PNG, JPEG, GIF or WebP up to 2 MB.',
          }));
          return;
        }
      }

      if (!text && !image) return;

      const entry = { id: crypto.randomUUID(), name, text, ts: Date.now() };
      if (image) entry.image = image;

      room.history.push(entry);
      if (room.history.length > HISTORY_LIMIT) room.history.shift();
      trimHistoryImages(room);
      broadcast(roomName, { type: 'message', ...entry });
    } else if (msg.type === 'typing') {
      broadcast(roomName, { type: 'typing', name }, ws);
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    broadcast(roomName, { type: 'system', text: `${name} left`, ts: Date.now() });
    broadcast(roomName, { type: 'presence', users: userList(roomName) });
    cleanupEmptyRoom(roomName);
  });

  ws.on('error', () => ws.terminate());
});

// Drop dead connections (e.g. laptop closed without a clean close frame)
const sweeper = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, IDLE_TIMEOUT_MS);

wss.on('close', () => clearInterval(sweeper));

server.listen(PORT, () => {
  console.log(`Chat server listening on :${PORT}`);
});
