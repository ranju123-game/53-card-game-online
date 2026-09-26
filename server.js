const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const rooms = new Map();
const PLAYER_COUNT = 5;

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(room, data) {
 for (const client of room.clients) send(client, data);
}

function publicState(room, playerIndex) {
  if (!room.state) return null;
  const state = JSON.parse(JSON.stringify(room.state));
  // Hide other players' actual cards in the data sent to each browser.
  // Card counts remain visible through the placeholder array length.
  state.players.forEach((p, i) => {
    if (i !== playerIndex) {
      p.hand = (p.hand || []).map((card, n) => ({
        id: `hidden_${i}_${n}`,
        rank: 'HIDDEN',
        suit: null
      }));
    }
  });
  state.selectedCards = [];
  return state;
}

function broadcastState(room) {
  if (!room.state) return;
  for (const client of room.clients) {
    send(client, { type: 'state', roomCode: room.code, state: publicState(room, client.playerIndex) });
  }
}

function mergeClientState(room, incoming, senderIndex) {
  if (!room.state) {
    room.state = incoming;
    return;
  }

  const old = room.state;
  const next = incoming;
  const keep = (key) => old[key];

  // Global game state is authoritative from the current game client.
  for (const key of [
    'deck','discardPile','indicator','indicatorAvailable','indicatorTaken',
    'roundStartingPlayer','universalRank','currentPlayer','hasDrawn','hasDiscarded',
    'turnMode','turnActionMade','turnMeldMade','firstTurnCompleted','meldsRevealed',
    'licensed','gameOver','gameWinner','gameStarted','lastRanking','roundScores','suffolCount','message'
  ]) {
    if (Object.prototype.hasOwnProperty.call(next, key)) old[key] = next[key];
  }

  // Only the sender's hand is accepted. Melds are public and may be changed
  // by the active player when extending another player's meld.
  if (Array.isArray(old.players) && Array.isArray(next.players)) {
    if (next.players[senderIndex] && Array.isArray(next.players[senderIndex].hand)) {
      old.players[senderIndex].hand = next.players[senderIndex].hand;
    }
    next.players.forEach((p, i) => {
      if (p && Array.isArray(p.melds)) old.players[i].melds = p.melds;
      if (p && typeof p.name === 'string') old.players[i].name = p.name;
    });
  }
}

const server = http.createServer((req, res) => {
  let file = req.url.split('?')[0];
  if (file === '/') file = '/index.html';
  const safe = path.normalize(file).replace(/^([.][.][\\/])+/, '');
  const full = path.join(ROOT, safe);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(full).toLowerCase();
    const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  ws.room = null;
  ws.playerIndex = -1;
  ws.isHost = false;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'create_room') {
      const code = roomCode();
      const room = { code, clients: [], state: null, host: ws };
      rooms.set(code, room);
      ws.room = room;
      ws.playerIndex = 0;
      ws.isHost = true;
      room.clients.push(ws);
      send(ws, { type: 'room_created', roomCode: code, playerIndex: 0 });
      send(ws, { type: 'room_status', count: 1 });
      return;
    }

    if (msg.type === 'join_room') {
      const code = String(msg.roomCode || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: 'Room not found.' });
      if (room.clients.length >= PLAYER_COUNT) return send(ws, { type: 'error', message: 'Room is full.' });
      const used = new Set(room.clients.map(c => c.playerIndex));
      let index = 0;
      while (used.has(index)) index++;
      ws.room = room;
      ws.playerIndex = index;
      room.clients.push(ws);
      send(ws, { type: 'joined', roomCode: code, playerIndex: index });
      broadcast(room, { type: 'room_status', count: room.clients.length });
      if (room.clients.length === PLAYER_COUNT) broadcast(room, { type: 'room_full' });
      if (room.state) broadcastState(room);
      return;
    }

    if (msg.type === 'state') {
      const room = ws.room;
      if (!room || !msg.state) return;
      if (!room.state) {
        if (!ws.isHost) return send(ws, { type:'error', message:'Waiting for the room creator to start the game.' });
        room.state = msg.state;
      } else if (msg.forceFull && ws.isHost) {
        room.state = msg.state;
      } else {
        mergeClientState(room, msg.state, ws.playerIndex);
      }
      broadcastState(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.clients = room.clients.filter(c => c !== ws);
    if (room.clients.length === 0) {
      rooms.delete(room.code);
      return;
    }
    broadcast(room, { type:'player_left', playerIndex: ws.playerIndex });
    broadcast(room, { type:'room_status', count: room.clients.length });
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`53 Card Game multiplayer server running on port ${PORT}`));
