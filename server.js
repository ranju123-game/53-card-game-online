const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const rooms = new Map();
const PLAYER_COUNT = 5;
const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const EMPTY_ROOM_GRACE_MS = 10 * 60 * 1000;

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(room, data) {
  for (const client of room.clients) send(client, data);
}

function connectedCount(room) {
  return room.clients.filter(c => c.readyState === WebSocket.OPEN).length;
}

function publicState(room, playerIndex) {
  if (!room.state) return null;
  const state = JSON.parse(JSON.stringify(room.state));
  // Hide other players' actual cards in the data sent to each browser.
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

function maybeStartNotification(room) {
  if (connectedCount(room) !== PLAYER_COUNT) return;
  // Do not send the start trigger again after a game has already begun.
  if (room.state && room.state.gameStarted) return;
  if (room.startNotificationSent) return;
  room.startNotificationSent = true;
  send(room.host, { type: 'room_full', gameAlreadyStarted: false });
}

function mergeClientState(room, incoming, senderIndex) {
  if (!room.state) {
    room.state = incoming;
    return;
  }

  const old = room.state;
  const next = incoming;

  // Only the player whose turn it currently is may update shared game state.
  // This prevents an out-of-date snapshot from another browser from restoring
  // cards to the draw pile (which could make the same card appear twice).
  const isActivePlayer = Number(senderIndex) === Number(old.currentPlayer);

  if (isActivePlayer) {
    for (const key of [
      'deck','discardPile','indicator','indicatorAvailable','indicatorTaken',
      'roundStartingPlayer','universalRank','currentPlayer','hasDrawn','hasDiscarded',
      'turnMode','turnActionMade','turnMeldMade','firstTurnCompleted','meldsRevealed',
      'licensed','gameOver','gameWinner','gameStarted','lastRanking','roundScores','suffolCount','message'
    ]) {
      if (Object.prototype.hasOwnProperty.call(next, key)) old[key] = next[key];
    }
  }

  if (Array.isArray(old.players) && Array.isArray(next.players)) {
    // Hand and meld changes are accepted only from the active player. A player
    // can still update their display name while it is someone else's turn.
    if (isActivePlayer && next.players[senderIndex] && Array.isArray(next.players[senderIndex].hand)) {
      old.players[senderIndex].hand = next.players[senderIndex].hand;
    }
    if (isActivePlayer) {
      next.players.forEach((p, i) => {
        if (!old.players[i] || !p) return;
        if (Array.isArray(p.melds)) old.players[i].melds = p.melds;
      });
    }
    next.players.forEach((p, i) => {
      if (!old.players[i] || !p) return;
      if (typeof p.name === 'string') old.players[i].name = p.name;
    });
  }
}

function attachPlayer(room, ws, seat, type) {
  // Replace any stale connection for this exact seat.
  const oldClient = room.clients.find(c => c.playerIndex === seat.playerIndex);
  if (oldClient && oldClient !== ws) {
    oldClient.room = null;
    try { oldClient.close(); } catch {}
    room.clients = room.clients.filter(c => c !== oldClient);
  }
  ws.room = room;
  ws.playerIndex = seat.playerIndex;
  ws.isHost = !!seat.isHost;
  seat.client = ws;
  seat.disconnectedAt = null;
  if (ws.isHost) room.host = ws;
  if (!room.clients.includes(ws)) room.clients.push(ws);

  send(ws, {
    type,
    roomCode: room.code,
    playerIndex: seat.playerIndex,
    token: seat.token,
    isHost: !!seat.isHost,
    state: publicState(room, seat.playerIndex)
  });
  broadcast(room, { type: 'room_status', count: connectedCount(room) });
  if (room.state) broadcastState(room);
  maybeStartNotification(room);
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
      const room = {
        code,
        clients: [],
        state: null,
        host: null,
        seats: Array(PLAYER_COUNT).fill(null),
        startNotificationSent: false,
        cleanupTimer: null
      };
      rooms.set(code, room);
      const seat = { playerIndex: 0, token: newToken(), isHost: true, client: null, disconnectedAt: null };
      room.seats[0] = seat;
      attachPlayer(room, ws, seat, 'room_created');
      return;
    }

    if (msg.type === 'join_room') {
      const code = String(msg.roomCode || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found. The room may have expired or the server may have restarted.' });
      const availableIndex = room.seats.findIndex(seat => !seat);
      if (availableIndex < 0) return send(ws, { type: 'error', message: 'All player seats are reserved or occupied. Reconnect with the original device/session.' });
      const seat = { playerIndex: availableIndex, token: newToken(), isHost: false, client: null, disconnectedAt: null };
      room.seats[availableIndex] = seat;
      attachPlayer(room, ws, seat, 'joined');
      return;
    }

    if (msg.type === 'reconnect') {
      const code = String(msg.roomCode || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found. The room may have expired or the server may have restarted.' });
      const token = String(msg.token || '');
      const seat = room.seats.find(s => s && s.token === token);
      if (!seat) return send(ws, { type: 'error', code: 'RESUME_EXPIRED', message: 'Reconnect session expired. Please join with the room code if a seat is available.' });
      if (seat.disconnectedAt && Date.now() - seat.disconnectedAt > RECONNECT_GRACE_MS) {
        room.seats[seat.playerIndex] = null;
        return send(ws, { type: 'error', code: 'RESUME_EXPIRED', message: 'Reconnect time expired. Please join again if a seat is available.' });
      }
      if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
      attachPlayer(room, ws, seat, 'reconnected');
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
      if (room.state && room.state.gameStarted) room.startNotificationSent = true;
      broadcastState(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.clients = room.clients.filter(c => c !== ws);
    const seat = room.seats[ws.playerIndex];
    if (seat && seat.client === ws) {
      seat.client = null;
      seat.disconnectedAt = Date.now();
    }
    if (room.host === ws) room.host = null;
    broadcast(room, { type:'player_left', playerIndex: ws.playerIndex });
    broadcast(room, { type:'room_status', count: connectedCount(room) });

    // Reserve the seat for a short reconnect window. If everyone disconnects,
    // retain the room briefly instead of deleting the in-progress game instantly.
    if (connectedCount(room) === 0) {
      if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
      room.cleanupTimer = setTimeout(() => {
        if (connectedCount(room) === 0) rooms.delete(room.code);
      }, EMPTY_ROOM_GRACE_MS);
    }

    if (seat) {
      setTimeout(() => {
        const current = room.seats[ws.playerIndex];
        if (current === seat && !seat.client && seat.disconnectedAt && Date.now() - seat.disconnectedAt >= RECONNECT_GRACE_MS) {
          room.seats[ws.playerIndex] = null;
          if (connectedCount(room) === 0 && room.seats.every(s => !s)) rooms.delete(room.code);
        }
      }, RECONNECT_GRACE_MS + 50);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`53 Card Game multiplayer server running on port ${PORT}`));
