import { catalogSchema, messageSchema } from './protocol'
import type { Config, Experiment, Snapshot, Transition } from './protocol'
import type { Checkpoints } from './checkpoints'

type Connection = 'connecting' | 'connected' | 'reconnecting' | 'standby' | 'offline'
export type Speed = '1×' | '4×' | '16×'
const pacing: Record<Speed, { count: number; delay: number }> = {
  '1×': { count: 1, delay: 115 },
  '4×': { count: 4, delay: 80 },
  '16×': { count: 8, delay: 28 },
}

interface TrainingState {
  experiments: Experiment[]
  config: Config | null
  snapshot: Snapshot | null
  events: Transition[]
  running: boolean
  busy: boolean
  connection: Connection
  speed: Speed
  storageError: boolean
  error: string | null
}

export class TrainingSession {
  private state: TrainingState = {
    experiments: [], config: null, snapshot: null, events: [], running: false, busy: false,
    connection: 'connecting', speed: '4×', storageError: false, error: null,
  }
  private listeners = new Set<() => void>()
  private socket?: WebSocket
  private timer?: number
  private watchdog?: number
  private failures = 0
  private pendingStep = false
  private awaiting = false
  private initializing = false
  private writes = Promise.resolve()

  constructor(private readonly checkpoints: Checkpoints) {}

  getState = () => this.state

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private update(changes: Partial<TrainingState>) {
    this.state = { ...this.state, ...changes }
    this.listeners.forEach(listener => listener())
  }

  initialize = async () => {
    if (this.initializing || this.state.config) return
    this.initializing = true
    this.update({ connection: 'connecting', error: null })
    try {
      const [experiments, snapshot] = await Promise.all([
        fetch('/api/experiments', { signal: AbortSignal.timeout(8_000) }).then(async response => {
          if (!response.ok) throw new Error('Experiment list is unavailable')
          return catalogSchema.parse(await response.json())
        }),
        this.checkpoints.load().catch(() => { this.update({ storageError: true }); return null }),
      ])
      this.update({ experiments, config: snapshot?.config ?? experiments[0].config, snapshot })
      this.connect()
    } catch {
      this.update({ error: 'The experiment list is unavailable. Try reconnecting.', connection: 'offline' })
    } finally {
      this.initializing = false
    }
  }

  setSpeed = (speed: Speed) => { this.update({ speed }) }

  reconnect = () => {
    if (!this.state.config) { void this.initialize(); return }
    this.failures = 0
    this.disconnect()
    this.connect()
  }

  reset = (config: Config) => {
    this.pendingStep = false
    this.disconnect()
    this.store(null)
    this.update({ config, snapshot: null, events: [], running: false, busy: false })
    this.reconnect()
  }

  toggle = () => {
    if (this.state.running) {
      this.update({ running: false })
      if (!this.awaiting && this.state.connection === 'connected') this.schedule()
      return
    }
    if (this.isComplete() || !this.state.config) return
    this.update({ running: true })
    this.requestWork()
  }

  step = () => {
    if (this.state.running || this.state.busy || this.isComplete() || !this.state.config) return
    this.pendingStep = true
    this.update({ busy: true })
    this.requestWork()
  }

  private isComplete() {
    return this.state.snapshot?.completed === this.state.config?.episodes
  }

  private requestWork() {
    if (this.state.connection === 'connected') this.sendBatch()
    else if (!this.socket && this.state.connection !== 'reconnecting') this.reconnect()
  }

  private connect() {
    const config = this.state.config
    if (!config) return
    window.clearTimeout(this.timer)
    const url = new URL('/api/ws', window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    this.socket = socket
    this.update({ connection: this.failures ? 'reconnecting' : 'connecting', error: null })
    this.timeout(socket)
    socket.onopen = () => {
      if (this.socket !== socket) return
      socket.send(JSON.stringify({ type: 'open', config, snapshot: this.state.snapshot }))
    }
    socket.onmessage = event => {
      if (this.socket !== socket) return
      try {
        const response = messageSchema.parse(JSON.parse(event.data))
        window.clearTimeout(this.watchdog)
        if (response.type === 'error') {
          this.disconnect()
          this.pendingStep = false
          this.update({ error: response.message, connection: 'offline', running: false, busy: false })
          return
        }
        if (response.type === 'batch') this.pendingStep = false
        this.awaiting = false
        this.failures = 0
        this.store(response.snapshot)
        const done = response.snapshot.completed >= config.episodes
        const recent = response.type === 'batch' ? [...response.events].reverse() : []
        const events = recent.concat(this.state.events).slice(0, 8)
        this.update({
          snapshot: response.snapshot, running: this.state.running && !done,
          busy: this.pendingStep, connection: 'connected',
          events: !events.length && response.snapshot.last ? [response.snapshot.last] : events,
        })
        this.schedule()
      } catch {
        this.disconnect()
        this.retry('Training returned an unreadable response.')
      }
    }
    socket.onclose = event => {
      if (this.socket !== socket) return
      this.disconnect()
      if (event.code === 1012 && !this.state.running && !this.pendingStep && this.state.snapshot) {
        this.update({ connection: 'standby', busy: false })
        return
      }
      this.retry()
    }
  }

  private retry(message = 'Connection lost. Retrying automatically.') {
    const delay = Math.min(500 * 2 ** this.failures, 8_000)
    this.failures = Math.min(this.failures + 1, 5)
    this.update({ connection: 'reconnecting', error: message, busy: this.pendingStep })
    this.timer = window.setTimeout(() => this.connect(), delay)
  }

  private timeout(socket: WebSocket) {
    window.clearTimeout(this.watchdog)
    this.watchdog = window.setTimeout(() => {
      if (this.socket !== socket) return
      this.disconnect()
      this.retry('Training timed out. Reconnecting.')
    }, 10_000)
  }

  private schedule() {
    window.clearTimeout(this.timer)
    if (this.state.running || this.pendingStep) {
      this.timer = window.setTimeout(() => this.sendBatch(), this.pendingStep ? 0 : pacing[this.state.speed].delay)
      return
    }
    this.timer = window.setTimeout(() => {
      this.disconnect()
      this.update({ connection: 'standby' })
    }, 20_000)
  }

  private sendBatch() {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN || this.awaiting || !(this.state.running || this.pendingStep)) return
    window.clearTimeout(this.timer)
    this.awaiting = true
    this.update({ busy: true })
    socket.send(JSON.stringify({ type: 'advance', count: this.pendingStep ? 1 : pacing[this.state.speed].count }))
    this.timeout(socket)
  }

  private disconnect() {
    window.clearTimeout(this.timer)
    window.clearTimeout(this.watchdog)
    const socket = this.socket
    this.socket = undefined
    this.awaiting = false
    socket?.close()
  }

  private store(snapshot: Snapshot | null) {
    this.writes = this.writes.then(() => this.checkpoints.save(snapshot)).catch(() => this.update({ storageError: true }))
  }
}
