'use strict';
// Uno Night — zero-dependency multiplayer card game server.
// Run: node server.js   (PORT env var optional, default 3000)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 10;
const DISCONNECT_GRACE_MS = 15000;
const ROOM_TTL_MS = 60 * 60 * 1000;

const rooms = new Map();
const COLORS = ['r', 'y', 'g', 'b'];
const rint = (n) => crypto.randomInt(n);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rint(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeDeck(copies) {
  const deck = [];
  let id = 0;
  const add = (c, v) => deck.push({ id: id++, c, v });
  for (let k = 0; k < copies; k++) {
    for (const c of COLORS) {
      add(c, '0');
      for (let i = 1; i <= 9; i++) { add(c, String(i)); add(c, String(i)); }
      for (const v of ['skip', 'rev', 'd2']) { add(c, v); add(c, v); }
    }
    for (let i = 0; i < 4; i++) { add('w', 'wild'); add('w', 'd4'); }
  }
  return deck;
}

function genCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[rint(letters.length)];
    if (!rooms.has(c)) return c;
  }
}

function newRoom() {
  const room = {
    code: genCode(),
    players: [],
    hostId: null,
    phase: 'lobby', // lobby | playing | over
    opts: { stack: true },
    deck: [], discard: [],
    color: null, turn: 0, dir: 1,
    pending: 0, pendingType: null,
    drawn: null, // id of card just drawn (may be played or passed)
    winner: null, vuln: null,
    log: [],
    clients: new Map(), // pid -> Set(res)
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addLog(room, text) { room.log.push({ k: 'sys', text }); if (room.log.length > 200) room.log.shift(); }
function addChat(room, who, text) { room.log.push({ k: 'chat', who, text }); if (room.log.length > 200) room.log.shift(); }

// ---------- game logic ----------

function topCard(room) { return room.discard[room.discard.length - 1]; }

function canPlay(room, card) {
  if (room.pending > 0) return room.opts.stack && card.v === room.pendingType;
  if (card.c === 'w') return true;
  const top = topCard(room);
  return card.c === room.color || card.v === top.v;
}

function reshuffle(room) {
  const top = room.discard.pop();
  room.deck = shuffle(room.discard);
  room.discard = [top];
}

function drawCards(room, p, n) {
  for (let i = 0; i < n; i++) {
    if (!room.deck.length) reshuffle(room);
    if (!room.deck.length) break;
    p.hand.push(room.deck.pop());
  }
  p.said = false;
}

// Move `steps` connected seats in the current direction.
function step(room, from, steps) {
  const n = room.players.length;
  let i = from, moved = 0, guard = 0;
  while (moved < steps && guard++ < 1000) {
    i = (i + room.dir + n) % n;
    if (room.players[i].connected) moved++;
  }
  return i;
}

const connectedCount = (room) => room.players.filter((p) => p.connected).length;

// If the player whose turn it is has dropped, make them auto-draw and move on.
function settleTurn(room) {
  if (room.phase !== 'playing') return;
  for (let g = 0; g < 20; g++) {
    const cur = room.players[room.turn];
    if (!cur || cur.connected || connectedCount(room) === 0) return;
    room.drawn = null;
    if (room.pending > 0) {
      drawCards(room, cur, room.pending);
      addLog(room, `${cur.name} is offline and drew ${room.pending}`);
      room.pending = 0; room.pendingType = null;
    } else {
      addLog(room, `${cur.name} is offline — turn skipped`);
    }
    room.turn = step(room, room.turn, 1);
  }
}

function startRound(room) {
  const n = room.players.length;
  room.deck = shuffle(makeDeck(n > 6 ? 2 : 1));
  for (const p of room.players) { p.hand = []; p.said = false; drawCards(room, p, 7); }
  let first;
  for (;;) {
    first = room.deck.pop();
    if (/^\d$/.test(first.v)) break;
    room.deck.unshift(first);
  }
  room.discard = [first];
  room.color = first.c;
  room.dir = 1; room.pending = 0; room.pendingType = null;
  room.drawn = null; room.winner = null; room.vuln = null;
  room.turn = rint(n);
  room.phase = 'playing';
  addLog(room, `New round! ${room.players[room.turn].name} goes first.`);
}

function removePlayer(room, pid) {
  const idx = room.players.findIndex((p) => p.id === pid);
  if (idx < 0) return;
  const [p] = room.players.splice(idx, 1);
  const set = room.clients.get(pid);
  if (set) {
    for (const r of set) { try { r.write('event: removed\ndata: {}\n\n'); r.end(); } catch (e) { /* ignore */ } }
    room.clients.delete(pid);
  }
  if (!room.players.length) { rooms.delete(room.code); return; }
  if (room.hostId === pid) room.hostId = (room.players.find((x) => x.connected) || room.players[0]).id;
  if (room.vuln === pid) room.vuln = null;
  if (room.phase !== 'playing') return;
  room.deck.unshift(...p.hand);
  const n = room.players.length;
  if (n < 2) {
    const w = room.players[0];
    room.phase = 'over'; room.winner = w.id; w.wins++;
    addLog(room, `${w.name} wins — everyone else left`);
    return;
  }
  if (idx < room.turn) room.turn--;
  else if (idx === room.turn) {
    room.drawn = null;
    room.turn = room.dir === 1 ? idx % n : (idx - 1 + n) % n;
  }
  settleTurn(room);
}

function handleAct(room, p, b) {
  room.lastActive = Date.now();
  const playing = room.phase === 'playing';
  const myTurn = playing && room.players[room.turn] === p;

  switch (b.type) {
    case 'start': {
      if (p.id !== room.hostId) return 'Only the host can start';
      if (playing) return 'Already started';
      for (const x of room.players.filter((x) => !x.connected && x.id !== p.id)) removePlayer(room, x.id);
      if (room.players.length < 2) return 'Need at least 2 players';
      startRound(room);
      return null;
    }
    case 'opts': {
      if (p.id !== room.hostId) return 'Only the host can change options';
      if (playing) return 'Game in progress';
      room.opts.stack = !!b.stack;
      return null;
    }
    case 'play': {
      if (!myTurn) return 'Not your turn';
      const card = p.hand.find((c) => c.id === b.cardId);
      if (!card) return 'You do not have that card';
      if (room.drawn !== null && card.id !== room.drawn) return 'You can only play the card you drew';
      if (!canPlay(room, card)) return "That card can't be played now";
      if (card.c === 'w' && !COLORS.includes(b.color)) return 'Pick a color';

      p.hand = p.hand.filter((c) => c.id !== card.id);
      room.discard.push(card);
      room.color = card.c === 'w' ? b.color : card.c;
      room.drawn = null;
      room.vuln = null;
      const names = { r: 'red', y: 'yellow', g: 'green', b: 'blue' };

      if (p.hand.length === 0) {
        room.phase = 'over'; room.winner = p.id; p.wins++;
        addLog(room, `${p.name} played their last card and wins the round!`);
        return null;
      }
      if (p.hand.length === 1) {
        if (p.said) addLog(room, `${p.name}: UNO!`);
        else room.vuln = p.id;
      }
      p.said = false;

      const nxtIdx = step(room, room.turn, 1);
      const nxt = room.players[nxtIdx];
      switch (card.v) {
        case 'skip':
          addLog(room, `${p.name} skipped ${nxt.name}`);
          room.turn = step(room, room.turn, 2);
          break;
        case 'rev':
          room.dir *= -1;
          addLog(room, `${p.name} reversed direction`);
          room.turn = step(room, room.turn, connectedCount(room) === 2 ? 2 : 1);
          break;
        case 'd2':
        case 'd4': {
          const amt = card.v === 'd2' ? 2 : 4;
          if (card.v === 'd4') addLog(room, `${p.name} played +4 and chose ${names[room.color]}`);
          if (room.opts.stack) {
            room.pending += amt; room.pendingType = card.v;
            room.turn = nxtIdx;
            addLog(room, `${p.name} played +${amt} (stack: ${room.pending})`);
          } else {
            drawCards(room, nxt, amt);
            addLog(room, `${p.name} made ${nxt.name} draw ${amt}`);
            room.turn = step(room, room.turn, 2);
          }
          break;
        }
        case 'wild':
          addLog(room, `${p.name} chose ${names[room.color]}`);
          room.turn = nxtIdx;
          break;
        default:
          room.turn = nxtIdx;
      }
      return null;
    }
    case 'draw': {
      if (!myTurn) return 'Not your turn';
      if (room.drawn !== null) return 'Play the card you drew, or pass';
      room.vuln = null;
      if (room.pending > 0) {
        const n = room.pending;
        drawCards(room, p, n);
        room.pending = 0; room.pendingType = null;
        addLog(room, `${p.name} drew ${n} cards`);
        room.turn = step(room, room.turn, 1);
      } else {
        drawCards(room, p, 1);
        const c = p.hand[p.hand.length - 1];
        addLog(room, `${p.name} drew a card`);
        if (c && canPlay(room, c)) room.drawn = c.id;
        else room.turn = step(room, room.turn, 1);
      }
      return null;
    }
    case 'pass': {
      if (!myTurn || room.drawn === null) return "You can't pass now";
      room.drawn = null; room.vuln = null;
      room.turn = step(room, room.turn, 1);
      return null;
    }
    case 'uno': {
      if (!playing) return 'Not in a round';
      if (room.vuln === p.id) { room.vuln = null; addLog(room, `${p.name}: UNO!`); return null; }
      if (p.hand.length <= 2) {
        if (!p.said) addLog(room, `${p.name}: UNO!`);
        p.said = true;
        return null;
      }
      return "You don't need to call UNO yet";
    }
    case 'catch': {
      if (!playing || !room.vuln || room.vuln === p.id) return 'Nobody to catch';
      const t = room.players.find((x) => x.id === room.vuln);
      room.vuln = null;
      if (t) { drawCards(room, t, 2); addLog(room, `${p.name} caught ${t.name} without UNO — +2 cards!`); }
      return null;
    }
    case 'chat': {
      const text = String(b.text || '').trim().slice(0, 200);
      if (!text) return 'Empty message';
      addChat(room, p.name, text);
      return null;
    }
    case 'kick': {
      if (p.id !== room.hostId) return 'Only the host can remove players';
      const t = room.players.find((x) => x.id === b.target);
      if (!t || t === p) return 'Invalid player';
      addLog(room, `${t.name} was removed by the host`);
      removePlayer(room, t.id);
      return null;
    }
    case 'leave': {
      addLog(room, `${p.name} left`);
      removePlayer(room, p.id);
      return null;
    }
    default:
      return 'Unknown action';
  }
}

// ---------- views & broadcasting ----------

function view(room, pid) {
  const me = room.players.find((p) => p.id === pid);
  const playing = room.phase === 'playing';
  const cur = playing ? room.players[room.turn] : null;
  let playable = [];
  if (playing && me && cur && cur.id === pid) {
    if (room.drawn !== null) {
      const c = me.hand.find((x) => x.id === room.drawn);
      if (c && canPlay(room, c)) playable = [c.id];
    } else playable = me.hand.filter((c) => canPlay(room, c)).map((c) => c.id);
  }
  return {
    code: room.code, phase: room.phase, you: pid, host: room.hostId, opts: room.opts,
    players: room.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar || '🙂', count: p.hand.length, connected: p.connected, wins: p.wins })),
    hand: me ? me.hand : [],
    top: room.discard.length ? topCard(room) : null,
    color: room.color, turn: cur ? cur.id : null, dir: room.dir,
    pending: room.pending, pendingType: room.pendingType, drawn: room.drawn,
    deck: room.deck.length, winner: room.winner, vuln: room.vuln,
    saidUno: me ? !!me.said : false, playable,
    log: room.log.slice(-60),
  };
}

function broadcast(room) {
  for (const [pid, set] of room.clients) {
    for (const res of set) {
      try { res.write('data: ' + JSON.stringify(view(room, pid)) + '\n\n'); } catch (e) { /* ignore */ }
    }
  }
}

function onDisconnect(room, pid) {
  const p = room.players.find((x) => x.id === pid);
  if (!p) return;
  p.connected = false;
  broadcast(room);
  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    const q = room.players.find((x) => x.id === pid);
    if (!q || q.connected) return;
    if (room.phase !== 'playing') {
      removePlayer(room, pid);
    } else {
      if (room.hostId === pid) {
        const other = room.players.find((x) => x.connected);
        if (other) room.hostId = other.id;
      }
      settleTurn(room);
    }
    if (rooms.has(room.code)) broadcast(room);
  }, DISCONNECT_GRACE_MS);
}

// ---------- HTTP ----------

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (d) => { data += d; if (data.length > 80000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const validPid = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Player';
const cleanAvatar = (s) => {
  if (typeof s !== 'string') return '';
  s = s.trim();
  if (!s) return '';
  if (s.startsWith('data:image/')) return s.length <= 50000 ? s : '';
  return Array.from(s).slice(0, 4).join('');
};

async function apiJoin(req, res) {
  const b = await readBody(req);
  if (!validPid(b.pid)) return json(res, 400, { ok: false, error: 'Bad player id' });
  const name = cleanName(b.name);
  const avatar = cleanAvatar(b.avatar);
  let room;
  if (b.room) {
    room = rooms.get(String(b.room).toUpperCase().trim());
    if (!room) return json(res, 404, { ok: false, error: 'Room not found' });
  } else {
    room = newRoom();
  }
  let p = room.players.find((x) => x.id === b.pid);
  if (p) {
    p.name = name;
    if (avatar) p.avatar = avatar;
  } else {
    if (room.phase === 'playing') return json(res, 200, { ok: false, error: 'That game is already in progress' });
    if (room.players.length >= MAX_PLAYERS) return json(res, 200, { ok: false, error: 'Room is full' });
    p = { id: b.pid, name, avatar: avatar || '🙂', hand: [], connected: false, wins: 0, said: false };
    room.players.push(p);
    if (!room.hostId) room.hostId = p.id;
    addLog(room, `${name} joined`);
    // Drop them again if they never open the live connection.
    setTimeout(() => {
      const q = rooms.has(room.code) && room.players.find((x) => x.id === p.id);
      if (q && !q.connected && room.phase !== 'playing') { removePlayer(room, p.id); if (rooms.has(room.code)) broadcast(room); }
    }, DISCONNECT_GRACE_MS);
  }
  room.lastActive = Date.now();
  broadcast(room);
  json(res, 200, { ok: true, room: room.code });
}

async function apiAct(req, res) {
  const b = await readBody(req);
  const room = rooms.get(String(b.room || '').toUpperCase());
  const p = room && room.players.find((x) => x.id === b.pid);
  if (!p) return json(res, 404, { ok: false, error: 'You are not in this room' });
  const err = handleAct(room, p, b);
  if (err) return json(res, 200, { ok: false, error: err });
  if (rooms.has(room.code)) broadcast(room);
  json(res, 200, { ok: true });
}

function sse(req, res, url) {
  const room = rooms.get((url.searchParams.get('room') || '').toUpperCase());
  const pid = url.searchParams.get('pid');
  const p = room && room.players.find((x) => x.id === pid);
  if (!p) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  let set = room.clients.get(pid);
  if (!set) { set = new Set(); room.clients.set(pid, set); }
  set.add(res);
  p.connected = true;
  room.lastActive = Date.now();
  broadcast(room);
  req.on('close', () => {
    set.delete(res);
    if (set.size === 0 && room.clients.get(pid) === set) {
      room.clients.delete(pid);
      onDisconnect(room, pid);
    }
  });
}

const INDEX = path.join(__dirname, 'index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/events') return sse(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/join') return await apiJoin(req, res);
    if (req.method === 'POST' && url.pathname === '/api/act') return await apiAct(req, res);
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'Server error' });
  }
});

// keep SSE connections alive through proxies
setInterval(() => {
  for (const room of rooms.values())
    for (const set of room.clients.values())
      for (const res of set) { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }
}, 15000);

// delete abandoned rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms)
    if (room.clients.size === 0 && now - room.lastActive > ROOM_TTL_MS) rooms.delete(code);
}, 60000);

server.listen(PORT, '0.0.0.0', () => console.log(`Uno Night running on http://localhost:${PORT}`));
