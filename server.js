const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const rooms = new Map();
const PLAYER_COUNT = 5;
const RECONNECT_GRACE_MS = 24 * 60 * 60 * 1000; // Keep player seats resumable for 24 hours.
const EMPTY_ROOM_GRACE_MS = 24 * 60 * 60 * 1000; // Keep an empty room and its game state for 24 hours.

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

// Validate that each physical card exists in only one live location.
// The indicator is a live card only while it is still available on the table;
// after it is taken, its metadata may remain in `indicator` but the card itself
// must be counted in the player's hand, discard pile, or meld instead.
function hasDuplicateCards(state) {
  if (!state || !Array.isArray(state.players) || !Array.isArray(state.deck) || !Array.isArray(state.discardPile)) {
    return true;
  }

  const seen = new Set();
  const addCard = card => {
    if (!card || !card.rank || card.rank === 'HIDDEN') return true;
    const key = card.rank === 'JOKER'
      ? 'JOKER'
      : `${String(card.rank)}|${String(card.suit)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  for (const card of state.deck) {
    if (!addCard(card)) return true;
  }

  for (const player of state.players) {
    if (!player) continue;
    for (const card of (Array.isArray(player.hand) ? player.hand : [])) {
      if (!addCard(card)) return true;
    }
    for (const meld of (Array.isArray(player.melds) ? player.melds : [])) {
      if (!Array.isArray(meld)) continue;
      for (const card of meld) {
        if (!addCard(card)) return true;
      }
    }
  }

  for (const card of state.discardPile) {
    if (!addCard(card)) return true;
  }

  if (state.indicatorAvailable && state.indicator && !addCard(state.indicator)) {
    return true;
  }

  return false;
}

function mergeClientState(room, incoming, senderIndex) {
  if (!room.state) {
    if (!hasDuplicateCards(incoming)) room.state = incoming;
    return !hasDuplicateCards(incoming);
  }

  // Work on a copy so a rejected snapshot cannot partially corrupt room.state.
  const old = JSON.parse(JSON.stringify(room.state));
  const next = incoming;

  // Only the player whose turn it currently is may update shared game state.
  // This blocks stale snapshots from restoring cards to the draw pile.
  const isActivePlayer = Number(senderIndex) === Number(old.currentPlayer);

  if (isActivePlayer) {
    for (const key of [
      'deck','discardPile','indicator','indicatorAvailable','indicatorTaken',
      'roundStartingPlayer','universalRank','currentPlayer','hasDrawn','hasDiscarded',
      'turnMode','turnActionMade','turnMeldMade','firstTurnCompleted','meldsRevealed',
      'licensed','gameOver','gameWinner','gameStarted','lastRanking','roundScores','suffolCount','message','seatingPhase','seatingPicks','seatOrder','initialStarter','seatingComplete','seatingServer','seatingReady'
    ]) {
      if (Object.prototype.hasOwnProperty.call(next, key)) old[key] = next[key];
    }
  }

  if (Array.isArray(old.players) && Array.isArray(next.players)) {
    // Only the active player may update a hand or melds. Names may be updated
    // by any connected player.
    if (isActivePlayer && next.players[senderIndex] && Array.isArray(next.players[senderIndex].hand)) {
      old.players[senderIndex].hand = next.players[senderIndex].hand;
    }
    if (isActivePlayer) {
      next.players.forEach((player, i) => {
        if (!old.players[i] || !player) return;
        if (Array.isArray(player.melds)) old.players[i].melds = player.melds;
      });
    }
    next.players.forEach((player, i) => {
      if (!old.players[i] || !player) return;
      if (typeof player.name === 'string') old.players[i].name = player.name;
    });
  }

  if (hasDuplicateCards(old)) return false;
  room.state = old;
  return true;
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
        seatingDeck: null,
        seatingPicks: [],
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
      // Prefer a never-used seat. If all seats are reserved, allow the room-code
      // holder to reclaim a DISCONNECTED seat so a refreshed/reopened tab can
      // resume the existing game without its old session token. Never take a
      // seat away from a player who is still connected.
      let availableIndex = -1;
      let reclaimingDisconnectedSeat = false;

      // A reconnect-token fallback should reclaim an existing disconnected seat
      // before using a never-used seat, preserving the player's game identity.
      if (msg.resumeFallback) {
        availableIndex = room.seats.findIndex(seat => seat && !seat.client);
        reclaimingDisconnectedSeat = availableIndex >= 0;
      }

      if (availableIndex < 0) {
        availableIndex = room.seats.findIndex(seat => !seat);
      }

      if (availableIndex < 0 && !reclaimingDisconnectedSeat) {
        availableIndex = room.seats.findIndex(seat => seat && !seat.client);
        reclaimingDisconnectedSeat = availableIndex >= 0;
      }

      if (availableIndex < 0) {
        return send(ws, { type: 'error', message: 'All player seats are currently connected. Use the original room session to reconnect.' });
      }

      let seat;
      if (reclaimingDisconnectedSeat) {
        seat = room.seats[availableIndex];
        // Rotate the token so an old browser session cannot replace this new connection.
        seat.token = newToken();
      } else {
        seat = { playerIndex: availableIndex, token: newToken(), isHost: false, client: null, disconnectedAt: null };
        room.seats[availableIndex] = seat;
      }

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
        // Keep the seat reserved in the room. The player can still use the room
        // code to reclaim this disconnected seat through join_room.
        return send(ws, { type: 'error', code: 'RESUME_EXPIRED', message: 'Reconnect token expired. Rejoining with the room code...' });
      }
      if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
      attachPlayer(room, ws, seat, 'reconnected');
      return;
    }

    if (msg.type === 'seating_pick') {
      const room = ws.room;
      if (!room || !room.state || !room.state.seatingPhase) return;
      if (room.seatingPicks.some(p => p.playerIndex === ws.playerIndex)) return;
      if (!room.seatingDeck) {
        const suits = ['♠', '♥', '♦', '♣'];
        const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
        room.seatingDeck = [];
        for (const suit of suits) for (const rank of ranks) room.seatingDeck.push({ rank, suit, id: `${rank}${suit}_seat` });
        for (let i = room.seatingDeck.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [room.seatingDeck[i], room.seatingDeck[j]] = [room.seatingDeck[j], room.seatingDeck[i]];
        }
      }
      if (!room.seatingDeck.length) return;
      const requestedIndex = Number.isInteger(Number(msg.cardIndex)) ? Number(msg.cardIndex) : -1;
      if (requestedIndex < 0 || requestedIndex >= room.seatingDeck.length) return;
      const card = room.seatingDeck.splice(requestedIndex, 1)[0];
      room.seatingPicks.push({ playerIndex: ws.playerIndex, card });
      room.state.seatingPicks = room.seatingPicks.map(p => ({ playerIndex: p.playerIndex, card: p.card }));
      if (room.seatingPicks.length === PLAYER_COUNT) {
        const rankValue = card => ({ A: 1, J: 11, Q: 12, K: 13 }[card.rank] || Number(card.rank) || 0);
        const highest = room.seatingPicks.reduce((best, p) => rankValue(p.card) > rankValue(best.card) ? p : best, room.seatingPicks[0]);
        room.state.seatingServer = highest.playerIndex;
        room.state.seatingReady = true;
      }
      broadcastState(room);
      return;
    }

    if (msg.type === 'seating_deal') {
      const room = ws.room;
      if (!room || !room.state || !room.state.seatingPhase || !room.state.seatingReady || room.state.seatingComplete) return;
      if (ws.playerIndex !== room.state.seatingServer || room.seatingPicks.length !== PLAYER_COUNT) return;
      // The highest-card player shuffles and deals the five revealed cards.
      const dealt = room.seatingPicks.slice();
      for (let i = dealt.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [dealt[i], dealt[j]] = [dealt[j], dealt[i]];
      }
      room.state.seatOrder = dealt.map(p => p.playerIndex);
      const highPos = room.state.seatOrder.indexOf(room.state.seatingServer);
      room.state.initialStarter = room.state.seatOrder[(highPos + 1) % PLAYER_COUNT];
      room.state.seatingComplete = true;
      broadcastState(room);
      return;
    }

    if (msg.type === 'state') {
      const room = ws.room;
      if (!room || !msg.state) return;
      let accepted = true;
      if (!room.state) {
        if (!ws.isHost) return send(ws, { type:'error', message:'Waiting for the room creator to start the game.' });
        if (hasDuplicateCards(msg.state)) accepted = false;
        else room.state = msg.state;
      } else if (msg.forceFull && ws.isHost) {
        if (hasDuplicateCards(msg.state)) accepted = false;
        else room.state = msg.state;
      } else {
        accepted = mergeClientState(room, msg.state, ws.playerIndex);
      }
      if (!accepted) {
        send(ws, { type:'error', code:'DUPLICATE_CARD_STATE', message:'Update rejected: the same card appeared in more than one place. The last valid game state was restored.' });
        broadcastState(room);
        return;
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
