import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import './App.css'

type Slot = 'p1' | 'p2'
type AttackType = 'none' | 'punch' | 'kick'
type MatchPhase = 'waiting' | 'countdown' | 'active' | 'postmatch'

type RuntimeFighter = {
  x: number
  y: number
  vy: number
  isJumping: boolean
  health: number
  attack: AttackType
  attackUntil: number
  cooldownUntil: number
}

type RoomPlayer = {
  name: string
  slot: Slot
  connected: boolean
  lastSeen: number
}

type Session = {
  roomCode: string
  slot: Slot
  token: string
}

type Controls = {
  left: boolean
  right: boolean
  up: boolean
}

type JoinResponse = {
  ok: boolean
  code?: string
  slot?: Slot
  token?: string
  error?: string
}

const SESSION_STORAGE_KEY = 'fighter_session'
const NAME_STORAGE_KEY = 'fighter_name'

const WORLD_WIDTH = 1000
const PLAYER_WIDTH = 90
const MOVE_SPEED = 420
const JUMP_SPEED = 760
const GRAVITY = 1850

const PUNCH_RANGE = 120
const KICK_RANGE = 180

const ATTACK_CONFIG = {
  punch: { damage: 10, cooldown: 300, duration: 160, range: PUNCH_RANGE },
  kick: { damage: 15, cooldown: 460, duration: 220, range: KICK_RANGE },
}

const initialFighter = (x: number): RuntimeFighter => ({
  x,
  y: 0,
  vy: 0,
  isJumping: false,
  health: 100,
  attack: 'none',
  attackUntil: 0,
  cooldownUntil: 0,
})

const initialFighters = (): Record<Slot, RuntimeFighter> => ({
  p1: initialFighter(140),
  p2: initialFighter(770),
})

function codeFromUrl(): string {
  const params = new URLSearchParams(window.location.search)
  return (params.get('room') || '').toUpperCase().trim()
}

function setRoomInUrl(roomCode: string | null) {
  const url = new URL(window.location.href)
  if (roomCode) {
    url.searchParams.set('room', roomCode)
  } else {
    url.searchParams.delete('room')
  }
  window.history.replaceState({}, '', url.toString())
}

function readStoredSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Session
    if (!parsed.roomCode || !parsed.slot || !parsed.token) {
      return null
    }
    return {
      roomCode: String(parsed.roomCode).toUpperCase(),
      slot: parsed.slot,
      token: String(parsed.token),
    }
  } catch {
    return null
  }
}

function getRoomClosedMessage(reason: string, actorSlot: Slot | null, mySlot: Slot | null): string {
  if (reason === 'left' && actorSlot === mySlot) {
    return 'You left the room.'
  }
  if (reason === 'timeout' && actorSlot === mySlot) {
    return 'You were disconnected for too long. Room closed.'
  }
  if (reason === 'left' && actorSlot === null) {
    return 'Room closed.'
  }
  if (reason === 'left') {
    return 'The other player left. You were returned to the home page.'
  }
  if (reason === 'declined') {
    return 'Rematch was declined. You were returned to the home page.'
  }
  if (reason === 'timeout') {
    return 'The other player disconnected for too long. Room closed.'
  }
  return 'Room closed.'
}

function App() {
  const [name, setName] = useState(() => sessionStorage.getItem(NAME_STORAGE_KEY) || '')
  const [nameDraft, setNameDraft] = useState(() => sessionStorage.getItem(NAME_STORAGE_KEY) || '')
  const [showGuide, setShowGuide] = useState(false)
  const [joinCode, setJoinCode] = useState(() => codeFromUrl())
  const [session, setSession] = useState<Session | null>(() => readStoredSession())
  const [players, setPlayers] = useState<RoomPlayer[]>([])
  const [fighters, setFighters] = useState<Record<Slot, RuntimeFighter>>(() => initialFighters())
  const [winner, setWinner] = useState<Slot | null>(null)
  const [phase, setPhase] = useState<MatchPhase>('waiting')
  const [rematchRequester, setRematchRequester] = useState<Slot | null>(null)
  const [readySlots, setReadySlots] = useState<Slot[]>([])
  const [countdownEndsAt, setCountdownEndsAt] = useState<number | null>(null)
  const [countdownId, setCountdownId] = useState<string | null>(null)
  const [clockMs, setClockMs] = useState(() => Date.now())
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0)
  const [connected, setConnected] = useState(false)
  const [isJoining, setIsJoining] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const controlsRef = useRef<Controls>({ left: false, right: false, up: false })
  const socketRef = useRef<Socket | null>(null)
  const lastFrameRef = useRef<number | null>(null)
  const lastStateEmitRef = useRef(0)
  const seenHitRef = useRef<Set<string>>(new Set())
  const countdownTimerRef = useRef<number | null>(null)
  const winnerReportedRef = useRef(false)
  const leavingRoomRef = useRef(false)
  const autoJoinTriedRef = useRef(false)

  const sessionRef = useRef<Session | null>(session)
  const nameRef = useRef(name)

  const syncServerClock = (serverNow?: number | null) => {
    if (typeof serverNow === 'number') {
      setServerClockOffsetMs(serverNow - Date.now())
    }
  }

  useEffect(() => {
    sessionRef.current = session
    if (session) {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
      setRoomInUrl(session.roomCode)
    } else {
      sessionStorage.removeItem(SESSION_STORAGE_KEY)
      setRoomInUrl(null)
    }
  }, [session])

  useEffect(() => {
    nameRef.current = name
  }, [name])

  const clearCountdownTicker = useCallback(() => {
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
  }, [])

  const clearMatchState = useCallback(() => {
    setFighters(initialFighters())
    setWinner(null)
    setPhase('waiting')
    setRematchRequester(null)
    setReadySlots([])
    setCountdownEndsAt(null)
    setCountdownId(null)
    setClockMs(Date.now())
    winnerReportedRef.current = false
    seenHitRef.current.clear()
    clearCountdownTicker()
  }, [clearCountdownTicker])

  const clearSession = useCallback(
    (message?: string) => {
      setSession(null)
      clearMatchState()
      if (message) {
        setInfo(message)
      }
    },
    [clearMatchState],
  )

  const applyJoinSuccess = useCallback((response: JoinResponse) => {
    if (!response.code || !response.slot || !response.token) {
      return false
    }

    setSession({ roomCode: response.code, slot: response.slot, token: response.token })
    setFighters(initialFighters())
    setWinner(null)
    setClockMs(Date.now())
    winnerReportedRef.current = false
    seenHitRef.current.clear()
    setError('')
    setInfo('')
    leavingRoomRef.current = false
    return true
  }, [])

  useEffect(() => {
    if (!countdownEndsAt || phase !== 'countdown') {
      clearCountdownTicker()
      return
    }

    countdownTimerRef.current = window.setInterval(() => {
      setClockMs(Date.now())
    }, 120)

    return () => {
      clearCountdownTicker()
    }
  }, [clearCountdownTicker, countdownEndsAt, phase])

  useEffect(() => {
    const socket = io({ transports: ['websocket', 'polling'], reconnection: true })
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)

      const activeSession = sessionRef.current
      const activeName = nameRef.current.trim()
      if (!activeSession || !activeName) {
        return
      }

      socket.emit(
        'join_room',
        { name: activeName, code: activeSession.roomCode, token: activeSession.token },
        (response: JoinResponse) => {
          if (!response.ok || !applyJoinSuccess(response)) {
            clearSession('Your previous room is no longer available.')
          }
        },
      )
    })

    socket.on('disconnect', () => {
      setConnected(false)
      if (sessionRef.current) {
        setInfo('Connection lost. Trying to reconnect...')
      }
    })

    socket.on('connect_error', () => {
      setError('Could not connect to server.')
    })

    socket.on('room_update', (payload: { players: RoomPlayer[] }) => {
      setPlayers(payload.players)
    })

    socket.on(
      'match_state',
      (payload: {
        phase: MatchPhase
        countdownEndsAt: number | null
        countdownId?: string | null
        serverNow?: number
        winner: Slot | null
        rematchRequester: Slot | null
        readySlots?: Slot[]
      }) => {
        syncServerClock(payload.serverNow)
        setPhase(payload.phase)
        setCountdownEndsAt(payload.countdownEndsAt)
        setCountdownId(payload.countdownId || null)
        setWinner(payload.winner)
        setRematchRequester(payload.rematchRequester)
        setReadySlots(payload.readySlots || [])
        setClockMs(Date.now())

        if (payload.phase === 'countdown') {
          setInfo('Match starts in 3...')
          winnerReportedRef.current = false
        }
        if (payload.phase === 'active') {
          setInfo('Fight!')
        }
      },
    )

    socket.on(
      'countdown_started',
      (payload: { countdownId: string; countdownEndsAt: number; serverNow?: number }) => {
        syncServerClock(payload.serverNow)
        setPhase('countdown')
        setCountdownEndsAt(payload.countdownEndsAt)
        setCountdownId(payload.countdownId)
        setClockMs(Date.now())
        winnerReportedRef.current = false
        setInfo('Match starts in 3...')
      },
    )

    socket.on('match_reset', () => {
      setFighters(initialFighters())
      setWinner(null)
      winnerReportedRef.current = false
      seenHitRef.current.clear()
    })

    socket.on(
      'room_closed',
      (payload: {
        reason: string
        actorSlot: Slot | null
      }) => {
        if (leavingRoomRef.current && payload.reason === 'left') {
          leavingRoomRef.current = false
          return
        }
        clearSession(getRoomClosedMessage(payload.reason, payload.actorSlot, sessionRef.current?.slot || null))
      },
    )

    socket.on('session_replaced', () => {
      clearSession('This session was opened elsewhere.')
    })

    socket.on(
      'player_state',
      (payload: {
        slot: Slot
        state: Pick<RuntimeFighter, 'x' | 'y' | 'health' | 'attack' | 'attackUntil' | 'isJumping'>
      }) => {
        setFighters((prev) => {
          const next = { ...prev }
          next[payload.slot] = {
            ...next[payload.slot],
            x: payload.state.x,
            y: payload.state.y,
            health: payload.state.health,
            attack: payload.state.attack,
            attackUntil: payload.state.attackUntil,
            isJumping: payload.state.isJumping,
          }
          return next
        })
      },
    )

    socket.on('player_jump', (payload: { slot: Slot }) => {
      setFighters((prev) => {
        const next = {
          p1: { ...prev.p1 },
          p2: { ...prev.p2 },
        }
        const fighter = next[payload.slot]
        if (fighter.y > 0) {
          return prev
        }
        fighter.vy = JUMP_SPEED
        fighter.isJumping = true
        return next
      })
    })

    socket.on('hit_event', (payload: { target: Slot; attackId: string; damage: number; from: Slot }) => {
      const currentSession = sessionRef.current
      if (!currentSession || payload.target !== currentSession.slot) {
        return
      }
      if (seenHitRef.current.has(payload.attackId)) {
        return
      }
      seenHitRef.current.add(payload.attackId)

      setFighters((prev) => {
        const next = { ...prev }
        const localFighter = { ...next[currentSession.slot] }
        localFighter.health = Math.max(0, localFighter.health - payload.damage)
        next[currentSession.slot] = localFighter

        if (localFighter.health <= 0) {
          setWinner(payload.from)
        }

        socket.emit('player_state', {
          roomCode: currentSession.roomCode,
          slot: currentSession.slot,
          token: currentSession.token,
          state: {
            x: localFighter.x,
            y: localFighter.y,
            health: localFighter.health,
            attack: localFighter.attack,
            attackUntil: localFighter.attackUntil,
            isJumping: localFighter.isJumping,
          },
        })

        return next
      })
    })

    return () => {
      clearCountdownTicker()
      socket.disconnect()
    }
  }, [applyJoinSuccess, clearCountdownTicker, clearSession])

  useEffect(() => {
    if (!session || !session.slot || phase !== 'countdown' || !countdownId) {
      return
    }

    socketRef.current?.emit('countdown_ack', {
      roomCode: session.roomCode,
      countdownId,
      token: session.token,
      slot: session.slot,
    })
  }, [countdownId, phase, session])

  useEffect(() => {
    if (!connected || !name.trim() || session || !joinCode || autoJoinTriedRef.current) {
      return
    }
    autoJoinTriedRef.current = true
    socketRef.current?.emit(
      'join_room',
      { name: name.trim(), code: joinCode.toUpperCase().trim(), token: undefined },
      (response: JoinResponse) => {
        if (!response.ok || !applyJoinSuccess(response)) {
          setError(response.error || 'Could not join room.')
        }
      },
    )
  }, [applyJoinSuccess, connected, joinCode, name, session])

  const slot = session?.slot || null
  const otherSlot: Slot | null = slot === 'p1' ? 'p2' : slot === 'p2' ? 'p1' : null

  const me = useMemo(() => players.find((player) => player.slot === slot) || null, [players, slot])
  const enemy = useMemo(
    () => players.find((player) => player.slot === otherSlot) || null,
    [players, otherSlot],
  )

  const battleActive = Boolean(
    session && phase === 'active' && me?.connected && enemy?.connected && !winner,
  )
  const p1FacingRight = fighters.p2.x >= fighters.p1.x
  const p2FacingRight = fighters.p1.x > fighters.p2.x
  const p1LeadArmClass = p1FacingRight ? 'arm arm-right arm-leading' : 'arm arm-left arm-leading'
  const p1TrailArmClass = p1FacingRight ? 'arm arm-left arm-trailing' : 'arm arm-right arm-trailing'
  const p1LeadLegClass = p1FacingRight ? 'leg leg-right leg-leading' : 'leg leg-left leg-leading'
  const p1TrailLegClass = p1FacingRight ? 'leg leg-left leg-trailing' : 'leg leg-right leg-trailing'
  const p2LeadArmClass = p2FacingRight ? 'arm arm-right arm-leading' : 'arm arm-left arm-leading'
  const p2TrailArmClass = p2FacingRight ? 'arm arm-left arm-trailing' : 'arm arm-right arm-trailing'
  const p2LeadLegClass = p2FacingRight ? 'leg leg-right leg-leading' : 'leg leg-left leg-leading'
  const p2TrailLegClass = p2FacingRight ? 'leg leg-left leg-trailing' : 'leg leg-right leg-trailing'

  const emitState = useCallback(
    (state: Pick<RuntimeFighter, 'x' | 'y' | 'health' | 'attack' | 'attackUntil' | 'isJumping'>) => {
      if (!session || !slot) {
        return
      }

      socketRef.current?.emit('player_state', {
        roomCode: session.roomCode,
        slot,
        token: session.token,
        state,
      })
    },
    [session, slot],
  )

  const reportMatchOver = useCallback(
    (winnerSlot: Slot) => {
      if (!session || winnerReportedRef.current) {
        return
      }
      winnerReportedRef.current = true
      socketRef.current?.emit('match_over', {
        roomCode: session.roomCode,
        winner: winnerSlot,
        token: session.token,
      })
    },
    [session],
  )

  const triggerAttack = useCallback(
    (type: 'punch' | 'kick') => {
      if (!session || !slot || !otherSlot || !battleActive) {
        return
      }

      const now = performance.now()
      const config = ATTACK_CONFIG[type]

      setFighters((prev) => {
        const next = {
          p1: { ...prev.p1 },
          p2: { ...prev.p2 },
        }

        const localFighter = next[slot]
        const enemyFighter = next[otherSlot]

        if (now < localFighter.cooldownUntil) {
          return prev
        }

        localFighter.attack = type
        localFighter.attackUntil = now + config.duration
        localFighter.cooldownUntil = now + config.cooldown

        const nearEnough = Math.abs(enemyFighter.x - localFighter.x) <= config.range
        const roughlySameHeight = Math.abs(enemyFighter.y - localFighter.y) < 90
        if (nearEnough && roughlySameHeight) {
          enemyFighter.health = Math.max(0, enemyFighter.health - config.damage)

          const attackId = `${slot}-${now}`
          socketRef.current?.emit('hit_event', {
            roomCode: session.roomCode,
            target: otherSlot,
            attackId,
            damage: config.damage,
            from: slot,
            token: session.token,
          })

          if (enemyFighter.health <= 0) {
            setWinner(slot)
            reportMatchOver(slot)
          }
        }

        emitState({
          x: localFighter.x,
          y: localFighter.y,
          health: localFighter.health,
          attack: localFighter.attack,
          attackUntil: localFighter.attackUntil,
          isJumping: localFighter.isJumping,
        })

        return next
      })
    },
    [battleActive, emitState, otherSlot, reportMatchOver, session, slot],
  )

  const triggerJump = useCallback(() => {
    if (!session || !slot || !battleActive) {
      return
    }
    const localFighter = fighters[slot]
    if (localFighter.y > 0 || localFighter.isJumping) {
      return
    }
    socketRef.current?.emit('player_jump', {
      roomCode: session.roomCode,
      slot,
      token: session.token,
    })
  }, [battleActive, fighters, session, slot])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        controlsRef.current.left = true
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        controlsRef.current.right = true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (battleActive) {
          triggerJump()
        }
      }

      if (!battleActive || !session) {
        return
      }

      if (key === 'a') {
        triggerAttack('punch')
      }
      if (key === 'd') {
        triggerAttack('kick')
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        controlsRef.current.left = false
      }
      if (event.key === 'ArrowRight') {
        controlsRef.current.right = false
      }
      if (event.key === 'ArrowUp') {
        controlsRef.current.up = false
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [battleActive, session, triggerAttack, triggerJump])

  useEffect(() => {
    if (!session || !slot || !otherSlot) {
      return
    }

    let rafId = 0

    const tick = (now: number) => {
      const prevTs = lastFrameRef.current ?? now
      const dt = Math.min((now - prevTs) / 1000, 0.04)
      lastFrameRef.current = now

      if (battleActive) {
        setFighters((prev) => {
          const next = {
            p1: { ...prev.p1 },
            p2: { ...prev.p2 },
          }

          const localFighter = next[slot]
          const remoteFighter = next[otherSlot]

          if (localFighter.attack !== 'none' && now > localFighter.attackUntil) {
            localFighter.attack = 'none'
          }

          const movingLeft = controlsRef.current.left && !controlsRef.current.right
          const movingRight = controlsRef.current.right && !controlsRef.current.left

          if (movingLeft) {
            localFighter.x -= MOVE_SPEED * dt
          }
          if (movingRight) {
            localFighter.x += MOVE_SPEED * dt
          }

          localFighter.x = Math.max(0, Math.min(WORLD_WIDTH - PLAYER_WIDTH, localFighter.x))

          const integrateJump = (fighter: RuntimeFighter) => {
            if (fighter.y <= 0 && fighter.vy <= 0 && !fighter.isJumping) {
              fighter.y = 0
              return
            }
            fighter.vy -= GRAVITY * dt
            fighter.y += fighter.vy * dt
            if (fighter.y <= 0) {
              fighter.y = 0
              fighter.vy = 0
              fighter.isJumping = false
            } else {
              fighter.isJumping = true
            }
          }

          integrateJump(localFighter)
          integrateJump(remoteFighter)

          if (now - lastStateEmitRef.current > 25) {
            emitState({
              x: localFighter.x,
              y: localFighter.y,
              health: localFighter.health,
              attack: localFighter.attack,
              attackUntil: localFighter.attackUntil,
              isJumping: localFighter.isJumping,
            })
            lastStateEmitRef.current = now
          }

          return next
        })
      }

      rafId = window.requestAnimationFrame(tick)
    }

    rafId = window.requestAnimationFrame(tick)

    return () => {
      window.cancelAnimationFrame(rafId)
      lastFrameRef.current = null
    }
  }, [battleActive, emitState, otherSlot, session, slot])

  const saveName = () => {
    const normalized = nameDraft.trim()
    if (!normalized) {
      setError('Please enter a username first.')
      return
    }
    sessionStorage.setItem(NAME_STORAGE_KEY, normalized)
    setName(normalized)
    autoJoinTriedRef.current = false
    setError('')
  }

  const ensureConnected = () => {
    if (socketRef.current?.connected) {
      return true
    }
    setError('Server is offline. Please wait for reconnection.')
    return false
  }

  const createRoom = () => {
    if (!name.trim()) {
      setError('Set your username first.')
      return
    }

    if (!ensureConnected()) {
      return
    }
    if (isCreating) {
      return
    }
    setIsCreating(true)
    socketRef.current?.emit(
      'create_room',
      { name: name.trim(), token: session?.token },
      (response: JoinResponse) => {
        setIsCreating(false)
        if (!response.ok || !applyJoinSuccess(response)) {
          setError(response.error || 'Could not create room.')
          return
        }
      },
    )
  }

  const joinRoom = () => {
    const code = joinCode.toUpperCase().trim()
    if (!name.trim()) {
      setError('Set your username first.')
      return
    }
    if (!code) {
      setError('Enter an invite code.')
      return
    }

    if (!ensureConnected()) {
      return
    }
    if (isJoining) {
      return
    }
    setIsJoining(true)
    socketRef.current?.emit(
      'join_room',
      { name: name.trim(), code, token: session?.token },
      (response: JoinResponse) => {
        setIsJoining(false)
        if (!response.ok || !applyJoinSuccess(response)) {
          setError(response.error || 'Could not join room.')
          return
        }
      },
    )
  }

  const leaveRoom = () => {
    leavingRoomRef.current = true
    if (session) {
      socketRef.current?.emit('leave_room', {
        roomCode: session.roomCode,
        token: session.token,
      })
    }
    clearSession('You left the room.')
    autoJoinTriedRef.current = false
  }

  const requestRematch = () => {
    if (!session || !slot || phase !== 'postmatch') {
      return
    }
    socketRef.current?.emit('request_rematch', {
      roomCode: session.roomCode,
      slot,
      token: session.token,
    })
  }

  const respondRematch = (accept: boolean) => {
    if (!session || !slot || phase !== 'postmatch') {
      return
    }
    socketRef.current?.emit('respond_rematch', {
      roomCode: session.roomCode,
      slot,
      accept,
      token: session.token,
    })
  }

  const markReady = () => {
    if (!session || !slot || phase !== 'waiting') {
      return
    }
    socketRef.current?.emit('playerReady', {
      roomCode: session.roomCode,
      slot,
      token: session.token,
    })
  }

  const inviteLink = session
    ? `${window.location.origin}${window.location.pathname}?room=${session.roomCode}`
    : ''

  const copyInvite = async () => {
    if (!inviteLink) {
      return
    }
    try {
      await navigator.clipboard.writeText(inviteLink)
      setInfo('Invite link copied.')
    } catch {
      setError('Copy failed. You can still copy the code manually.')
    }
  }

  const healthP1 = Math.max(0, fighters.p1.health)
  const healthP2 = Math.max(0, fighters.p2.health)

  const p1Bottom = 22 + fighters.p1.y / 5
  const p2Bottom = 22 + fighters.p2.y / 5

  const shouldShowRematchButton = phase === 'postmatch' && rematchRequester === null
  const waitingForRematchAnswer = phase === 'postmatch' && rematchRequester === slot
  const canRespondToRematch =
    phase === 'postmatch' && rematchRequester !== null && rematchRequester !== slot
  const amReady = Boolean(slot && readySlots.includes(slot))
  const bothReady = readySlots.includes('p1') && readySlots.includes('p2')
  const canShowReadyButton = phase === 'waiting' && Boolean(enemy?.connected) && Boolean(slot)
  const showLeaveButton = !canRespondToRematch
  const countdownValue =
    phase === 'countdown' && countdownEndsAt
      ? Math.max(
          0,
          Math.ceil((countdownEndsAt - (clockMs + serverClockOffsetMs)) / 1000),
        )
      : 0

  return (
    <div className="page">
      <header className="topbar">
        <h1>Street Rooftop Duel</h1>
        <div className={`status ${connected ? 'online' : 'offline'}`}>
          {connected ? 'Connected' : 'Disconnected'}
        </div>
      </header>

      {!name && (
        <section className="panel">
          <h2>Choose username</h2>
          <div className="row">
            <input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              placeholder="Your fighter name"
              maxLength={20}
            />
            <button onClick={saveName}>Save</button>
          </div>
        </section>
      )}

      {name && !session && (
        <section className="panel">
          <h2>Home</h2>
          <p className="sub">Player: {name}</p>
          <button onClick={() => setShowGuide((prev) => !prev)}>
            {showGuide ? 'Hide Guide' : 'Show Guide'}
          </button>
          {showGuide && (
            <div className="guide">
              <h3>How To Play</h3>
              <p>1. Create an invite and share the link or room code.</p>
              <p>2. Move with Arrow Left and Arrow Right.</p>
              <p>3. Wait for both players to click Ready, then watch the 3, 2, 1 countdown.</p>
              <p>4. Punch with A and front-kick with D.</p>
              <p>5. Beat your opponent health bar, then choose rematch or leave.</p>
            </div>
          )}
          <div className="row">
            <button onClick={createRoom} disabled={!connected || isCreating}>
              {isCreating ? 'Creating...' : 'Create Invite'}
            </button>
          </div>
          <div className="row">
            <input
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
              placeholder="Invite code"
              maxLength={8}
            />
            <button onClick={joinRoom} disabled={!connected || isJoining}>
              {isJoining ? 'Joining...' : 'Join Game'}
            </button>
          </div>
        </section>
      )}

      {name && session && (
        <section className="panel">
          <div className="roomHeader">
            <h2>Room {session.roomCode}</h2>
            <div className="headerActions">
              {canShowReadyButton && !amReady && <button onClick={markReady}>Ready</button>}
              {shouldShowRematchButton && <button onClick={requestRematch}>Rematch</button>}
              {canRespondToRematch && (
                <>
                  <button onClick={() => respondRematch(true)}>Accept Rematch</button>
                  <button onClick={() => respondRematch(false)}>Decline Rematch & Leave</button>
                </>
              )}
              {showLeaveButton && <button onClick={leaveRoom}>Leave</button>}
            </div>
          </div>

          <div className="inviteRow">
            <input readOnly value={inviteLink} />
            <button onClick={copyInvite}>Copy Invite Link</button>
          </div>

          <p className="sub">
            {!enemy
              ? 'Waiting for the other player.'
              : phase === 'waiting' && !amReady
                ? 'Click Ready when you are set to fight.'
                : phase === 'waiting' && amReady && !bothReady
                  ? 'Waiting for the other player to click Ready.'
              : phase === 'countdown'
                ? 'Get ready. Match countdown started.'
                : phase === 'active'
                  ? 'Fight now. Arrow keys to move, A punch, D front kick.'
                  : phase === 'postmatch'
                    ? waitingForRematchAnswer
                      ? 'Rematch requested. Waiting for opponent response.'
                      : canRespondToRematch
                        ? 'Opponent requested rematch. Accept or decline.'
                        : 'Match finished. Choose rematch or leave.'
                    : 'Waiting for both players to be ready.'}
          </p>

          <div className="healthBoard">
            <div>
              <div className="label">
                {players.find((p) => p.slot === 'p1')?.name || 'Player 1'}
                {slot === 'p1' ? ' (You)' : ''}
                {players.find((p) => p.slot === 'p1')?.connected === false ? ' (Offline)' : ''}
                {phase === 'waiting' && players.find((p) => p.slot === 'p1')?.connected
                  ? readySlots.includes('p1')
                    ? ' (Ready)'
                    : ' (Not Ready)'
                  : ''}
              </div>
              <div className="bar">
                <div className="fill p1" style={{ width: `${healthP1}%` }} />
              </div>
            </div>
            <div>
              <div className="label">
                {players.find((p) => p.slot === 'p2')?.name || 'Waiting for second player'}
                {slot === 'p2' ? ' (You)' : ''}
                {players.find((p) => p.slot === 'p2')?.connected === false ? ' (Offline)' : ''}
                {phase === 'waiting' && players.find((p) => p.slot === 'p2')?.connected
                  ? readySlots.includes('p2')
                    ? ' (Ready)'
                    : ' (Not Ready)'
                  : ''}
              </div>
              <div className="bar">
                <div className="fill p2" style={{ width: `${healthP2}%` }} />
              </div>
            </div>
          </div>

          <div className="arena">
            <div
              className={`fighter p1 ${p1FacingRight ? 'face-right leading-right' : 'face-left leading-left'} ${fighters.p1.attack !== 'none' ? `attack-${fighters.p1.attack}` : ''} ${fighters.p1.isJumping ? 'jumping' : ''}`}
              style={{ left: `${(fighters.p1.x / WORLD_WIDTH) * 100}%`, bottom: `${p1Bottom}px` }}
            >
              <span className="fighterName">{players.find((p) => p.slot === 'p1')?.name || 'P1'}</span>
              <div className="sprite">
                <div className="head" />
                <div className="torso" />
                <div className={p1TrailArmClass} />
                <div className={p1LeadArmClass} />
                <div className={p1TrailLegClass} />
                <div className={p1LeadLegClass} />
              </div>
            </div>

            <div
              className={`fighter p2 ${p2FacingRight ? 'face-right leading-right' : 'face-left leading-left'} ${fighters.p2.attack !== 'none' ? `attack-${fighters.p2.attack}` : ''} ${fighters.p2.isJumping ? 'jumping' : ''}`}
              style={{ left: `${(fighters.p2.x / WORLD_WIDTH) * 100}%`, bottom: `${p2Bottom}px` }}
            >
              <span className="fighterName">{players.find((p) => p.slot === 'p2')?.name || 'Waiting for second player'}</span>
              <div className="sprite">
                <div className="head" />
                <div className="torso" />
                <div className={p2TrailArmClass} />
                <div className={p2LeadArmClass} />
                <div className={p2TrailLegClass} />
                <div className={p2LeadLegClass} />
              </div>
            </div>

            <div className="ground" />

            {phase === 'countdown' && countdownValue > 0 && (
              <div className="countdownOverlay">{countdownValue}</div>
            )}

            {phase === 'postmatch' && winner && (
              <div className="result">
                <strong>{winner === slot ? 'You win' : 'You lose'}</strong>
                <p>Use rematch buttons above to start again.</p>
              </div>
            )}
          </div>
        </section>
      )}

      {info && <p className="info">{info}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

export default App
