// server.js
// Real-time chat server. No database, no Firebase — everything lives in
// process memory and disappears when the server restarts (by design).
//
// Abuse policy (strict):
//   • offences 1-3  → message is dropped, sender gets a warning (3 chances)
//   • offence 4     → sender's IP is blocked: "You Exceed You Limit Bye Bye 👋"
//   • blocked IPs are refused on HTTP (403 page) and on WebSocket connect
// Strike / block data is in memory only, so a server restart clears all blocks.

const express = require('express');
const path = require('path');
const http = require('http');
const net = require('net');
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

// ───────────────────────── Moderation settings ─────────────────────────
const MAX_WARNINGS = 3;                                  // chances before the block
const BLOCK_MESSAGE = 'You Exceed You Limit Bye Bye 👋';
const BLOCK_CLOSE_CODE = 4003;                           // custom WebSocket close code

// Where do we read the visitor's real IP from?
//  • On Render (RENDER env var is set) traffic comes through Cloudflare, which
//    sets True-Client-IP / CF-Connecting-IP. Clients can't forge those, but they
//    CAN forge X-Forwarded-For, so we deliberately do not use that header there.
//  • Other hosts: set TRUST_PROXY_HOPS=N (number of proxies in front of the app)
//    and the Nth-from-last X-Forwarded-For entry is used.
//  • Local/dev: neither set → plain socket address.
const BEHIND_CLOUDFLARE = process.env.BEHIND_CLOUDFLARE === '1' || Boolean(process.env.RENDER);
const TRUST_PROXY_HOPS = Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS || '0', 10) || 0);

// ───────────────────────── Abuse word filter ─────────────────────────

// Matched only when they are a WHOLE word, so "class", "assume", "Scunthorpe",
// "cocktail" and "retardant" are safe.
const WHOLE_WORDS = [
  // English
  'shit', 'shits', 'shite', 'ass', 'arse', 'dick', 'dicks', 'cock', 'cocks',
  'cunt', 'cunts', 'pussy', 'pussies', 'whore', 'whores', 'slut', 'sluts', 'twat',
  'wanker', 'wankers', 'prick', 'pricks', 'retard', 'retarded', 'retards',
  'nigger', 'niggers', 'nigga', 'niggas', 'fag', 'fags', 'kike',
  // Hindi / Hinglish / Bhojpuri (romanised)
  'bsdk', 'chut', 'gaand', 'gand', 'gandu', 'gaandu', 'randi', 'raand', 'randwa',
  'lund', 'lauda', 'lawda', 'lavda', 'chudai', 'chodu', 'kamina', 'kamine', 'kameena',
  'harami', 'haramzada', 'haramzade', 'haramkhor', 'bhadwa', 'bhadwe', 'bhadva',
  'bhadve', 'jhatu', 'jhantu',
];

// Matched ANYWHERE inside a word ("fuckyou", "motherfucker", "bhenchodd").
// Only words that never occur inside innocent words belong here.
const STRONG_WORDS = [
  'fuck', 'bitch', 'bastard', 'asshole', 'dickhead', 'cocksucker', 'bollocks',
  'bullshit', 'horseshit', 'dipshit', 'shithead', 'shitface', 'shitty', 'faggot',
  'madarchod', 'maderchod', 'madharchod', 'behenchod', 'behanchod', 'bahenchod',
  'bhenchod', 'benchod', 'bhosd', 'bhosad', 'chutiya', 'chutiye', 'chutia', 'chootiya',
];

// Devanagari spellings (matched as substrings, spaces ignored)
const DEVANAGARI_WORDS = [
  'मादरचोद', 'बहनचोद', 'भेनचोद', 'भोसड़ी', 'चूतिया', 'चुतिया',
  'गांडू', 'हरामी', 'रंडी', 'कमीना',
].map((w) => w.normalize('NFKD'));

// Extra words without touching the code:  EXTRA_BAD_WORDS="word1,word2"
const extraWords = (process.env.EXTRA_BAD_WORDS || '')
  .split(',')
  .map((w) => w.trim().toLowerCase().replace(/[^a-z]/g, ''))
  .filter(Boolean);
WHOLE_WORDS.push(...extraWords);

// "fuck" → f+u+c+k+  (so "fuuuuck" still matches)
// "ass"  → a+s{2,}   (so the normal word "as" does NOT match)
const toPattern = (w) =>
  w.replace(/(.)\1*/g, (run, c) => (run.length === 1 ? `${c}+` : `${c}{${run.length},}`));

const WHOLE_RE = new RegExp(`^(?:${WHOLE_WORDS.map(toPattern).join('|')})$`);
const STRONG_RE = new RegExp(STRONG_WORDS.map(toPattern).join('|'));
const STRONG_FULL_RE = new RegExp(`^(?:${STRONG_WORDS.map(toPattern).join('|')})$`);
const DEVANAGARI_RE = new RegExp(DEVANAGARI_WORDS.join('|'));
const WILDCARD_TARGETS = [
  ...WHOLE_WORDS.map((w) => [w, true]),
  ...STRONG_WORDS.map((w) => [w, false]),
];

// Cyrillic / Greek letters that look like Latin ones (а → a, о → o …)
const HOMOGLYPHS = {
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x',
  '\u0443': 'y', '\u0456': 'i', '\u0455': 's', '\u043a': 'k', '\u043c': 'm', '\u043d': 'h',
  '\u0442': 't', '\u03bf': 'o', '\u03b1': 'a', '\u03b5': 'e', '\u03b9': 'i', '\u03bd': 'v',
};

// Look-alike digits/symbols used to dodge filters (sh1t, a$$, @ss, b!tch …)
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '+': 't' };
const LEET_RE = /[01345789@$+]/g;

// Lower-case, strip accents / zero-width / invisible characters, fix look-alike letters
function prepare(input) {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u200b-\u200f\u202a-\u202e\u2060\ufeff\u00ad]/g, '')
    .toLowerCase()
    .replace(/[\u2018\u2019`]/g, "'")
    .replace(/[\u0370-\u03ff\u0400-\u04ff]/g, (c) => HOMOGLYPHS[c] || c);
}

// Censored words such as f**k, sh*t, a**hole: '*' stands for any letter.
// At least two real letters must match (one for 3-letter words), so "****" is fine.
function wildcardMatch(token, word, whole) {
  const n = word.length;
  if (token.length < n || (whole && token.length !== n)) return false;
  for (let start = 0; start + n <= token.length; start++) {
    let real = 0;
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const c = token[start + i];
      if (c === '*') continue;
      if (c === word[i]) real++; else ok = false;
    }
    if (ok && (real >= 2 || (real >= 1 && n <= 3))) return true;
  }
  return false;
}

// true if the text contains abusive language
function containsAbuse(input) {
  const text = prepare(input);
  if (!text) return false;

  // 1) Devanagari script
  if (DEVANAGARI_RE.test(text.replace(/\s+/g, ''))) return true;

  // 2) Latin script — split into words ("sh!t" → "shit", "f.u.c.k" → f,u,c,k)
  const tokens = text
    .replace(/(?<=[a-z])!(?=[a-z])/g, 'i')
    .split(/[^a-z0-9@$+*']+/)
    .map((t) => t.replace(/^[*']+|[*']+$/g, ''))
    .filter(Boolean);
  const mapped = tokens.map((t) => (/^\d+$/.test(t) ? t : t.replace(LEET_RE, (ch) => LEET[ch])));

  // 2a) each word on its own
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (raw.includes('*') && /^[a-z*]+$/.test(raw)) {
      if (WILDCARD_TARGETS.some(([w, whole]) => wildcardMatch(raw, w, whole))) return true;
      continue;
    }
    if (WHOLE_RE.test(mapped[i]) || STRONG_RE.test(mapped[i])) return true;
  }

  // 2b) words split apart: "madar chod", "fu ck", "s h i t"
  //     Joined neighbours must equal a bad word exactly ("a bit chilly" is safe).
  for (let i = 0; i < mapped.length; i++) {
    let joined = '';
    let allSingle = true;
    for (let k = 0; k < 12 && i + k < mapped.length; k++) {
      const t = mapped[i + k];
      if (t.includes("'")) break;                 // "who're", "that's" are never joined
      joined += t;
      if (joined.length > 30) break;
      if (t.length > 1) allSingle = false;
      if (k === 0) continue;
      if (STRONG_FULL_RE.test(joined)) return true;
      if (allSingle && k >= 2 && WHOLE_RE.test(joined)) return true;
    }
  }
  return false;
}

// ───────────────────────── Client IP helpers ─────────────────────────

function expandIpv6(ip) {
  const [head, tail] = ip.split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? new Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((g) => g.padStart(4, '0'));
}

// IPv4 stays as-is. IPv6 is reduced to its /64 — one home connection owns
// billions of addresses, so blocking a single one would be pointless.
function normalizeIp(ip) {
  if (!ip) return 'unknown';
  const clean = String(ip).trim().replace(/^::ffff:/i, '');
  if (net.isIPv4(clean)) return clean;
  if (net.isIPv6(clean)) return `${expandIpv6(clean).slice(0, 4).join(':')}::/64`;
  return clean;
}

function getClientIp(req) {
  const h = req.headers;
  let ip = req.socket.remoteAddress;

  if (BEHIND_CLOUDFLARE) {
    ip = h['true-client-ip'] || h['cf-connecting-ip'] || ip;
  } else if (TRUST_PROXY_HOPS > 0 && h['x-forwarded-for']) {
    const chain = String(h['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
    ip = chain[chain.length - TRUST_PROXY_HOPS] || ip;
  }
  return normalizeIp(ip);
}

// ───────────────────────── Offender tracking (memory only) ─────────────────────────

/** ip → { warnings, blocked } */
const offenders = new Map();
const isBlocked = (ip) => offenders.get(ip)?.blocked === true;

const BLOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Blocked</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#fff;
font:700 clamp(1.5rem,5vw,2.5rem) system-ui,sans-serif;text-align:center;padding:1rem}</style></head>
<body><p>${BLOCK_MESSAGE}</p></body></html>`;

const app = express();
app.get('/healthz', (_req, res) => res.status(200).send('ok')); // for Render health checks (never blocked)

// Blocked IPs get nothing but the goodbye page — not even the static files
app.use((req, res, next) => {
  if (!isBlocked(getClientIp(req))) return next();
  res.status(403).type('html').send(BLOCKED_PAGE);
});
app.use(express.static(path.join(__dirname, 'public')));

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

// ───────────────────────── Warn / block ─────────────────────────

// Tell a socket it is blocked, then hang up on it
function disconnectBlocked(ws) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'error', code: 'blocked', blocked: true, text: BLOCK_MESSAGE }));
  }
  ws.close(BLOCK_CLOSE_CODE, 'blocked');
  setTimeout(() => ws.terminate(), 2000).unref(); // in case the client never answers the close
}

// Block the IP and kick EVERY open connection (all tabs, all rooms) from it
function blockIp(ip) {
  const rec = offenders.get(ip) || { warnings: 0, blocked: false };
  rec.blocked = true;
  offenders.set(ip, rec);
  console.log(`[abuse] blocked ${ip}`);
  for (const client of wss.clients) {
    if (client.ip === ip) disconnectBlocked(client);
  }
}

function registerViolation(ws, name, roomName) {
  const rec = offenders.get(ws.ip) || { warnings: 0, blocked: false };
  offenders.set(ws.ip, rec);
  rec.warnings += 1;

  if (rec.warnings > MAX_WARNINGS) {
    broadcast(roomName, { type: 'system', text: `${name} was blocked for abusive language`, ts: Date.now() }, ws);
    blockIp(ws.ip);
    return;
  }

  const left = MAX_WARNINGS - rec.warnings;
  const text = left > 0
    ? `⚠️ Abusive language is not allowed. Warning ${rec.warnings}/${MAX_WARNINGS} — ${left} chance${left === 1 ? '' : 's'} left before you are blocked.`
    : `⚠️ Final warning ${rec.warnings}/${MAX_WARNINGS}. Your next abusive message gets you blocked.`;
  ws.send(JSON.stringify({
    type: 'error', code: 'abuse_warning', warnings: rec.warnings, maxWarnings: MAX_WARNINGS, text,
  }));
}

wss.on('connection', (ws, req) => {
  ws.on('error', () => ws.terminate());

  ws.ip = getClientIp(req);
  if (isBlocked(ws.ip)) {            // blocked visitors never get into a room
    disconnectBlocked(ws);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const rawRoom = url.searchParams.get('room') || 'general';
  const rawName = url.searchParams.get('name') || 'Guest';
  // Abusive room / display names are silently replaced
  const roomName = (!containsAbuse(rawRoom) && sanitize(rawRoom, 40)) || 'general';
  const requestedName = (!containsAbuse(rawName) && sanitize(rawName, 24)) || 'Guest';

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
    if (isBlocked(ws.ip)) return;    // ignore anything still in flight after a block

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'message' || msg.type === 'image') {
      const rawText = String(msg.text || '').slice(0, MAX_MSG_LEN);

      // Abuse check runs on the caption of image messages too.
      // The offending message is dropped: never stored, never broadcast.
      if (containsAbuse(rawText)) {
        registerViolation(ws, name, roomName);
        return;
      }

      const text = sanitize(rawText, MAX_MSG_LEN).trim();
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
