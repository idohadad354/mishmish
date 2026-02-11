import express from 'express'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Server } from 'socket.io'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DISCONNECT_GRACE_MS = 90_000
const MATCH_COUNTDOWN_MS = 3_000

const app = express()
const server = createServer(app)

const io = new Server(server, {
  cors: {
    origin: '*',
  },
})

const rooms = new Map()
const socketIndex = new Map()

function generateCode() {
  let code = ''
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

function normalizeName(name) {
  return String(name || '').trim().slice(0, 20)
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().trim()
}

function normalizeToken(token) {
  const value = String(token || '').trim()
  return value || randomUUID()
}

function clearDisconnectTimer(player) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer)
    player.disconnectTimer = null
  }
}

function stopRoomCountdown(room) {
  if (room.countdownTimer) {
    clearTimeout(room.countdownTimer)
    room.countdownTimer = null
  }
}

function serializePlayers(room) {
  return ['p1', 'p2']
    .map((slot) => room.players.get(slot))
    .filter(Boolean)
    .map((player) => ({
      name: player.name,
      slot: player.slot,
      connected: player.connected,
      lastSeen: player.lastSeen,
    }))
}

function hasTwoConnected(room) {
  const players = serializePlayers(room)
  return players.length === 2 && players.every((player) => player.connected)
}

function emitRoomUpdate(roomCode) {
  const room = rooms.get(roomCode)
  if (!room) {
    return
  }

  io.to(roomCode).emit('room_update', {
    code: roomCode,
    players: serializePlayers(room),
    started: hasTwoConnected(room),
  })
}

function emitMatchState(roomCode) {
  const room = rooms.get(roomCode)
  if (!room) {
    return
  }

  io.to(roomCode).emit('match_state', {
    phase: room.phase,
    countdownEndsAt: room.countdownEndsAt,
    countdownId: room.countdownId,
    serverNow: Date.now(),
    winner: room.winner,
    rematchRequester: room.rematchRequester,
    readySlots: [...room.readySlots],
  })
}

function getRoomPlayerByToken(room, token) {
  return [...room.players.values()].find((player) => player.token === token) || null
}

function closeRoom(roomCode, reason, actorSlot = null) {
  const room = rooms.get(roomCode)
  if (!room) {
    return
  }

  stopRoomCountdown(room)

  for (const player of room.players.values()) {
    clearDisconnectTimer(player)
    if (player.socketId) {
      socketIndex.delete(player.socketId)
    }
  }

  io.to(roomCode).emit('room_closed', {
    reason,
    actorSlot,
  })

  rooms.delete(roomCode)
}

function startCountdown(roomCode) {
  const room = rooms.get(roomCode)
  if (!room) {
    return
  }

  stopRoomCountdown(room)

  room.phase = 'countdown'
  room.countdownEndsAt = Date.now() + MATCH_COUNTDOWN_MS
  room.countdownId = randomUUID()
  room.countdownAcks = new Set()
  room.countdownElapsed = false
  room.winner = null
  room.rematchRequester = null

  io.to(roomCode).emit('match_reset')
  io.to(roomCode).emit('countdown_started', {
    countdownId: room.countdownId,
    countdownEndsAt: room.countdownEndsAt,
    serverNow: Date.now(),
  })
  emitMatchState(roomCode)

  room.countdownTimer = setTimeout(() => {
    const latestRoom = rooms.get(roomCode)
    if (!latestRoom) {
      return
    }

    latestRoom.countdownTimer = null
    latestRoom.countdownElapsed = true

    if (!hasTwoConnected(latestRoom)) {
      latestRoom.phase = 'waiting'
      latestRoom.countdownEndsAt = null
      latestRoom.countdownId = null
      latestRoom.countdownAcks = new Set()
      emitMatchState(roomCode)
      return
    }

    const connectedPlayers = [...latestRoom.players.values()].filter((player) => player.connected)
    const allAcked =
      connectedPlayers.length === 2 &&
      connectedPlayers.every((player) => latestRoom.countdownAcks.has(player.token))

    if (!allAcked) {
      return
    }

    latestRoom.phase = 'active'
    latestRoom.countdownEndsAt = null
    latestRoom.countdownId = null
    latestRoom.countdownAcks = new Set()
    emitMatchState(roomCode)
  }, MATCH_COUNTDOWN_MS + 100)
}

function maybeStartMatch(roomCode) {
  const room = rooms.get(roomCode)
  if (!room) {
    return
  }

  if (!hasTwoConnected(room)) {
    return
  }

  if (!room.readySlots.has('p1') || !room.readySlots.has('p2')) {
    return
  }

  if (room.phase === 'waiting') {
    startCountdown(roomCode)
  }
}

function attachPlayerSocket(socket, roomCode, player) {
  clearDisconnectTimer(player)

  if (player.socketId && player.socketId !== socket.id) {
    socketIndex.delete(player.socketId)
    const oldSocket = io.sockets.sockets.get(player.socketId)
    if (oldSocket) {
      oldSocket.emit('session_replaced')
      oldSocket.disconnect(true)
    }
  }

  player.socketId = socket.id
  player.connected = true
  player.lastSeen = Date.now()

  socketIndex.set(socket.id, { roomCode, token: player.token })
  socket.join(roomCode)
}

function markDisconnected(socketId) {
  const index = socketIndex.get(socketId)
  if (!index) {
    return
  }

  socketIndex.delete(socketId)

  const room = rooms.get(index.roomCode)
  if (!room) {
    return
  }

  const player = getRoomPlayerByToken(room, index.token)
  if (!player) {
    return
  }

  player.connected = false
  player.socketId = null
  player.lastSeen = Date.now()

  clearDisconnectTimer(player)
  player.disconnectTimer = setTimeout(() => {
    closeRoom(index.roomCode, 'timeout', player.slot)
  }, DISCONNECT_GRACE_MS)

  if (room.phase === 'active' || room.phase === 'countdown') {
    room.phase = 'waiting'
    room.winner = null
    room.rematchRequester = null
    room.readySlots = new Set()
    room.countdownEndsAt = null
    room.countdownId = null
    room.countdownAcks = new Set()
    room.countdownElapsed = false
    stopRoomCountdown(room)
    emitMatchState(index.roomCode)
  }

  emitRoomUpdate(index.roomCode)
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name, token }, ack) => {
    const normalizedName = normalizeName(name)
    if (!normalizedName) {
      ack({ ok: false, error: 'Name is required.' })
      return
    }

    let roomCode = generateCode()
    while (rooms.has(roomCode)) {
      roomCode = generateCode()
    }

    const player = {
      slot: 'p1',
      name: normalizedName,
      token: normalizeToken(token),
      socketId: socket.id,
      connected: true,
      lastSeen: Date.now(),
      lastState: null,
      disconnectTimer: null,
    }

    rooms.set(roomCode, {
      code: roomCode,
      players: new Map([['p1', player]]),
      phase: 'waiting',
      readySlots: new Set(),
      countdownEndsAt: null,
      countdownId: null,
      countdownAcks: new Set(),
      countdownElapsed: false,
      countdownTimer: null,
      winner: null,
      rematchRequester: null,
    })

    attachPlayerSocket(socket, roomCode, player)
    emitRoomUpdate(roomCode)
    emitMatchState(roomCode)

    ack({ ok: true, code: roomCode, slot: 'p1', token: player.token })
  })

  socket.on('join_room', ({ name, code, token }, ack) => {
    const roomCode = normalizeCode(code)
    const room = rooms.get(roomCode)
    if (!room) {
      ack({ ok: false, error: 'Room not found.' })
      return
    }

    const normalizedName = normalizeName(name)
    if (!normalizedName) {
      ack({ ok: false, error: 'Name is required.' })
      return
    }

    const normalizedToken = normalizeToken(token)
    const existing = getRoomPlayerByToken(room, normalizedToken)

    if (existing) {
      existing.name = normalizedName
      if (!existing.lastState) {
        existing.lastState = null
      }
      attachPlayerSocket(socket, roomCode, existing)
      emitRoomUpdate(roomCode)
      emitMatchState(roomCode)
      maybeStartMatch(roomCode)
      ack({ ok: true, code: roomCode, slot: existing.slot, token: existing.token, restored: true })
      return
    }

    if (room.players.size >= 2) {
      ack({ ok: false, error: 'Room is full.' })
      return
    }

    const slot = room.players.has('p1') ? 'p2' : 'p1'
    const player = {
      slot,
      name: normalizedName,
      token: normalizedToken,
      socketId: socket.id,
      connected: true,
      lastSeen: Date.now(),
      lastState: null,
      disconnectTimer: null,
    }

    room.players.set(slot, player)
    attachPlayerSocket(socket, roomCode, player)
    emitRoomUpdate(roomCode)
    emitMatchState(roomCode)
    maybeStartMatch(roomCode)

    ack({ ok: true, code: roomCode, slot, token: player.token, restored: false })
  })

  socket.on('leave_room', ({ roomCode, token }, ack) => {
    const code = normalizeCode(roomCode)
    const room = rooms.get(code)

    if (!room) {
      if (typeof ack === 'function') {
        ack({ ok: true })
      }
      return
    }

    const player = getRoomPlayerByToken(room, String(token || '').trim())
    if (!player) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Player session not found.' })
      }
      return
    }

    closeRoom(code, 'left', player.slot)
    if (typeof ack === 'function') {
      ack({ ok: true })
    }
  })

  socket.on('player_state', ({ roomCode, slot, token, state }) => {
    const code = normalizeCode(roomCode)
    const room = rooms.get(code)
    if (!room) {
      return
    }

    const player = room.players.get(slot)
    if (!player || player.token !== token || player.socketId !== socket.id || !player.connected) {
      return
    }

    player.lastSeen = Date.now()
    player.lastState = state
    socket.to(code).emit('player_state', {
      roomCode: code,
      slot,
      state,
    })
  })

  socket.on('hit_event', ({ roomCode, target, attackId, damage, from, token }) => {
    const code = normalizeCode(roomCode)
    const room = rooms.get(code)
    if (!room || room.phase !== 'active') {
      return
    }

    const player = room.players.get(from)
    if (!player || player.token !== token || player.socketId !== socket.id || !player.connected) {
      return
    }

    player.lastSeen = Date.now()
    socket.to(code).emit('hit_event', {
      roomCode: code,
      target,
      attackId,
      damage,
      from,
    })
  })

  socket.on('player_jump', ({ roomCode, slot, token }) => {
    const code = normalizeCode(roomCode)
    const room = rooms.get(code)
    if (!room || room.phase !== 'active') {
      return
    }

    const player = room.players.get(slot)
    if (!player || player.token !== token || player.socketId !== socket.id || !player.connected) {
      return
    }

    if (player.lastState && (player.lastState.y > 1 || player.lastState.isJumping)) {
      return
    }

    player.lastSeen = Date.now()
    if (player.lastState) {
      player.lastState.isJumping = true
    }
    io.to(code).emit('player_jump', {
      roomCode: code,
      slot,
    })
  })

  socket.on('playerReady', ({ roomCode, slot, token }) => {
    const code = normalizeCode(roomCode)
    const room = rooms.get(code)
    if (!room || room.phase !== 'waiting') {
      return
    }

    const player = room.players.get(slot)
    if (!player || player.token !== token || player.socketId !== socket.id || !player.connected) {
      return
    }

    room.readySlots.add(slot)
    emitMatchState(code)
    maybeStartMatch(code)
  })

  socket.on('countdown_ack', ({ roomCode, countdownId, token, slot }) => {
    const code = normalizeCode(roomCode)
    const room = rooms.get(code)
    if (!room || room.phase !== 'countdown' || room.countdownId !== countdownId) {
      return
    }

    const player = room.players.get(slot)
    if (!player || player.token !== token || player.socketId !== socket.id || !player.connected) {
      return
    }

    room.countdownAcks.add(player.token)

    if (!room.countdownElapsed) {
      return
    }

    if (!hasTwoConnected(room)) {
      return
    }

    const connectedPlayers = [...room.players.values()].filter((entry) => entry.connected)
    const allAcked =
      connectedPlayers.length === 2 &&
      connectedPlayers.every((entry) => room.countdownAcks.has(entry.token))

    if (!allAcked) {
      return
    }

    room.phase = 'active'
    room.countdownEndsAt = null
    room.countdownId = null
    room.countdownAcks = new Set()
    emitMatchState(code)
  })

  socket.on('match_over', ({ roomCode, winner, token }) => {
    const code = normalizeCode(roomCode)
    const room = rooms.get(code)
    if (!room || room.phase !== 'active') {
      return
    }

    const winnerPlayer = room.players.get(winner)
    if (!winnerPlayer || winnerPlayer.token !== token || winnerPlayer.socketId !== socket.id) {
      return
    }

    room.phase = 'postmatch'
    room.winner = winner
    room.readySlots = new Set()
    room.rematchRequester = null
    room.countdownEndsAt = null
    stopRoomCountdown(room)
    emitMatchState(code)
  })

  socket.on('request_rematch', ({ roomCode, slot, token }) => {
    const code = normalizeCode(roomCode)
    const room = rooms.get(code)
    if (!room || room.phase !== 'postmatch' || room.rematchRequester) {
      return
    }

    const player = room.players.get(slot)
    if (!player || player.token !== token || player.socketId !== socket.id || !player.connected) {
      return
    }

    room.rematchRequester = slot
    emitMatchState(code)
  })

  socket.on('respond_rematch', ({ roomCode, slot, accept, token }) => {
    const code = normalizeCode(roomCode)
    const room = rooms.get(code)
    if (!room || room.phase !== 'postmatch' || !room.rematchRequester) {
      return
    }

    const player = room.players.get(slot)
    if (!player || player.token !== token || player.socketId !== socket.id || !player.connected) {
      return
    }

    if (room.rematchRequester === slot) {
      return
    }

    if (accept) {
      room.phase = 'waiting'
      room.winner = null
      room.rematchRequester = null
      room.readySlots = new Set()
      room.countdownEndsAt = null
      room.countdownId = null
      room.countdownAcks = new Set()
      room.countdownElapsed = false
      stopRoomCountdown(room)
      io.to(code).emit('match_reset')
      emitMatchState(code)
      return
    }

    closeRoom(code, 'declined', slot)
  })

  socket.on('disconnect', () => {
    markDisconnected(socket.id)
  })
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size })
})

const distPath = path.join(__dirname, 'dist')
if (existsSync(distPath)) {
  app.use(express.static(distPath))
  app.use((_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => {
    res.send('Game server running. Build frontend or run Vite separately.')
  })
}

const PORT = Number(process.env.PORT || 3000)
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`)
})
