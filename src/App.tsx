import {
  Activity, ArrowDownRight, ArrowRight, BookOpen, ChevronDown, CircleHelp, Flag, FlaskConical,
  Gauge, History, Moon, Pause, Play, Radio, RotateCcw, Settings2, SkipForward, Sun, Target, X,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { BrowserCheckpoints } from './checkpoints'
import Maze, { actionIcons, actionNames, coordinate } from './Maze'
import { configSchema } from './protocol'
import type { Config, Position, Snapshot, Transition } from './protocol'
import { TrainingSession } from './training'
import type { Speed } from './training'

const Performance = lazy(() => import('./Performance'))
const training = new TrainingSession(new BrowserCheckpoints())
const emptyHistory: Snapshot['history'] = []
const speeds: Speed[] = ['1×', '4×', '16×']
const connectionLabels = { connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', standby: 'Standby', offline: 'Offline' }
const fixed = (value: number | undefined, places = 2) => value === undefined ? '—' : (Math.abs(value) < 0.5 * 10 ** -places ? 0 : value).toFixed(places)
const signed = (value: number) => `${value > 0 ? '+' : ''}${fixed(value)}`

function Modal({ title, trigger, children }: { title: string; trigger: string; children: (close: () => void) => ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  return <>
    <button className="button secondary" onClick={() => ref.current?.showModal()}>
      {trigger === 'Settings' ? <Settings2 aria-hidden="true" /> : <BookOpen aria-hidden="true" />}<span>{trigger}</span>
    </button>
    <dialog ref={ref} className="dialog" aria-label={title}>
      <div className="dialog-heading"><h2>{title}</h2><button className="button icon-button" aria-label="Close dialog" onClick={() => ref.current?.close()}><X aria-hidden="true" /></button></div>
      {children(() => ref.current?.close())}
    </dialog>
  </>
}

const settingsFields: { key: Exclude<keyof Config, 'maze'>; label: string; min: number; max: number; step: number }[] = [
  { key: 'episodes', label: 'Episodes', min: 1, max: 2000, step: 1 },
  { key: 'max_steps', label: 'Step limit per episode', min: 10, max: 500, step: 1 },
  { key: 'alpha', label: 'Learning rate (α)', min: 0.01, max: 1, step: 0.01 },
  { key: 'gamma', label: 'Discount factor (γ)', min: 0, max: 1, step: 0.01 },
  { key: 'epsilon', label: 'Initial exploration (ε)', min: 0, max: 1, step: 0.01 },
  { key: 'epsilon_min', label: 'Minimum exploration', min: 0, max: 1, step: 0.01 },
  { key: 'epsilon_decay', label: 'Exploration decay', min: 0.01, max: 1, step: 0.01 },
  { key: 'seed', label: 'Random seed', min: 0, max: 2 ** 32 - 1, step: 1 },
]

function Settings({ config, onApply, close }: { config: Config; onApply: (config: Config) => void; close: () => void }) {
  const [error, setError] = useState('')
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const values = Object.fromEntries(settingsFields.map(field => [field.key, Number(form.get(field.key))]))
    const parsed = configSchema.safeParse({ maze: config.maze, ...values })
    if (!parsed.success) { setError('Minimum exploration must be at most initial exploration.'); return }
    setError('')
    onApply(parsed.data)
    close()
  }
  return <form onSubmit={submit}>
    <p className="dialog-intro">Applying changes starts a fresh run and replaces the current checkpoint.</p>
    <div className="fields">
      {settingsFields.map(field => <label key={field.key}>{field.label}<input required type="number" name={field.key} min={field.min} max={field.max} step={field.step} defaultValue={config[field.key]} /></label>)}
    </div>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="button secondary" onClick={close}>Cancel</button><button className="button primary" type="submit">Apply and reset</button></div>
  </form>
}

function Inspector({ snapshot, selected }: { snapshot: Snapshot | null; selected: Position | null }) {
  const position = selected ?? snapshot?.state ?? [0, 0]
  const event = snapshot?.last
  const values = snapshot?.q[position[0] * 9 + position[1]] ?? [0, 0, 0, 0]
  const max = Math.max(...values)
  const stats = [
    ['Reward', event && signed(event.reward)], ['Q before', fixed(event?.q_before, 3)],
    ['TD target', fixed(event?.td_target, 3)], ['TD error', fixed(event?.td_error, 3)],
    ['Q after', fixed(event?.q_after, 3)],
  ]
  return <section className="panel inspector" aria-labelledby="inspect-heading">
    <div className="panel-heading"><div><h2 id="inspect-heading">Q-learning inspector</h2><p>Action values and the latest update</p></div><Target className="section-icon" aria-hidden="true" /></div>
    <div className="panel-body inspector-body">
      <div className="inspector-caption"><h3>State values</h3><span className="token">{coordinate(position)}</span></div>
      <div className="action-values">
        {values.map((value, index) => {
          const Icon = actionIcons[index]
          return <div key={actionNames[index]} className={`action-value${value === max && values.some(other => other !== max) ? ' best' : ''}`}>
            <span><Icon aria-hidden="true" />{actionNames[index]}</span><strong>{fixed(value, 3)}</strong>
          </div>
        })}
      </div>
      <div className="inspector-caption update-title"><h3>Latest transition</h3><span className="small muted">{event ? `Episode ${event.episode} · Step ${event.step}` : 'Awaiting step'}</span></div>
      <div className="transition-strip" aria-label="Latest state transition">
        <strong>{event ? coordinate(event.state) : '—'}</strong><span><ArrowRight aria-hidden="true" />{event ? actionNames[event.action] : 'Action'}</span><strong>{event ? coordinate(event.next_state) : '—'}</strong>
      </div>
      <dl className="update-values">
        {stats.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value ?? '—'}</dd></div>)}
      </dl>
    </div>
  </section>
}

function EventFeed({ events }: { events: Transition[] }) {
  return <section className="panel events" aria-labelledby="event-heading">
    <div className="panel-heading"><div><h2 id="event-heading">Event stream</h2><p>Latest actions received from the trainer</p></div><Radio className="section-icon" aria-hidden="true" /></div>
    {events.length ? <ol className="event-list">
      {events.map(event => {
        const Icon = actionIcons[event.action]
        return <li key={`${event.episode}-${event.step}`}>
          <span className="event-icon"><Icon aria-hidden="true" /></span>
          <span><strong>{coordinate(event.state)} <ArrowRight aria-hidden="true" /> {coordinate(event.next_state)}</strong><small>{actionNames[event.action]} · {event.explored ? 'Explore' : 'Exploit'}</small></span>
          <span className={event.reward > 0 ? 'positive' : 'negative'}>{signed(event.reward)}</span>
        </li>
      })}
    </ol> : <div className="event-empty"><History aria-hidden="true" /><p>Actions appear here as the agent moves.</p></div>}
  </section>
}

export default function App() {
  const state = useSyncExternalStore(training.subscribe, training.getState)
  const { config, snapshot, running, connection } = state
  const [selected, setSelected] = useState<Position | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('maze-theme') === 'light' ? 'light' : 'dark' } catch { return 'dark' }
  })
  const confirmation = useRef<HTMLDialogElement>(null)
  const [replacement, setReplacement] = useState<Config | null>(null)
  const experiment = state.experiments.find(item => item.id === config?.maze)
  const complete = !!snapshot && snapshot.completed === config?.episodes
  const wins = snapshot ? snapshot.wins : 0
  const completed = snapshot?.completed ?? 0

  useEffect(() => { void training.initialize() }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('maze-theme', theme) } catch { /* Theme remains active for this page. */ }
  }, [theme])

  function apply(next: Config) {
    setSelected(null)
    training.reset(next)
  }

  function replace(next: Config) {
    if (!snapshot?.total_steps) { apply(next); return }
    setReplacement(next)
    confirmation.current?.showModal()
  }

  const runLabel = running ? 'Pause training' : complete ? 'Training complete' : snapshot?.total_steps ? 'Resume training' : 'Start training'
  return <>
    <a href="#workspace" className="skip-link">Skip to training workspace</a>
    <header className="site-header">
      <div className="header-inner">
        <a href="#top" className="brand"><span className="brand-icon"><FlaskConical aria-hidden="true" /></span><span>Maze<span>Lab</span></span></a>
        <nav aria-label="Main navigation"><a href="#workspace">Workspace</a><a href="#metrics">Metrics</a></nav>
        <div className="header-actions">
          <Modal title="How Q-learning works" trigger="Guide">{close => <div className="guide">
            <p>The agent learns which moves earn the best long-term return. Each episode begins at the start and ends at the goal or the step limit.</p>
            <p>With probability ε the agent explores a random move. Otherwise it chooses a highest-valued action. Exploration decreases after each episode.</p>
            <div className="formula">Q(s,a) ← Q(s,a) + α × TD error</div>
            <p>The TD error is the target minus the old Q-value. The target is reward plus γ times the best next-state Q-value. At the end of an episode the target is the reward alone.</p>
            <p>The goal gives +1.00, a blocked move costs 0.12, and a normal move costs 0.03. Use <strong>Step</strong> to inspect an individual update.</p>
            <div className="dialog-actions"><button className="button primary" onClick={close}>Back to lab</button></div>
          </div>}</Modal>
          <button className="button icon-button theme-button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          </button>
        </div>
      </div>
    </header>
    <main id="top" className="shell">
      <section className="hero" aria-labelledby="page-title">
        <div>
          <div className="eyebrow"><span /> REINFORCEMENT LEARNING LAB</div>
          <h1 id="page-title">AI Maze Learning Lab</h1>
          <p>Train an agent to solve a maze, one decision at a time.</p>
        </div>
        <div className="connection" data-status={connection} role="status"><span />{connectionLabels[connection]}</div>
      </section>
      {(state.error || state.storageError) && <div className="notice" role="status">
        <CircleHelp aria-hidden="true" /><span>{[state.error, state.storageError && 'Browser storage is unavailable. Keep this tab open to retain your progress.'].filter(Boolean).join(' ')}</span>
        {state.error && <button className="text-button" onClick={training.reconnect}>Retry now</button>}
      </div>}
      <section id="workspace" className="workspace" aria-label="Training workspace">
        <div className="toolbar">
          <label className="experiment-picker">
            <span className="field-icon"><FlaskConical aria-hidden="true" /></span><span className="picker-label">Experiment</span>
            <select value={experiment?.id ?? ''} onChange={event => {
              const next = state.experiments.find(item => item.id === event.target.value)
              if (next) replace(next.config)
            }} aria-label="Experiment" disabled={!experiment}>
              {!experiment && <option value="">Loading…</option>}{state.experiments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select><ChevronDown className="select-caret" aria-hidden="true" />
          </label>
          <div className="toolbar-actions">
            <label className="speed-picker"><Gauge aria-hidden="true" /><span className="sr-only">Playback speed</span><select value={state.speed} onChange={event => {
              const speed = speeds.find(item => item === event.target.value)
              if (speed) training.setSpeed(speed)
            }}>{speeds.map(speed => <option key={speed}>{speed}</option>)}</select></label>
            {config && <Modal title="Training settings" trigger="Settings">{close => <Settings key={JSON.stringify(config)} config={config} onApply={apply} close={close} />}</Modal>}
            <button className="button icon-button reset" disabled={!config} aria-label="Reset training" title="Reset training" onClick={() => config && replace(config)}><RotateCcw aria-hidden="true" /></button>
            <button className="button secondary step" disabled={!config || running || state.busy || complete} onClick={training.step}><SkipForward aria-hidden="true" />Step</button>
            <button className="button primary run" disabled={!config || complete} onClick={training.toggle}>{running ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{runLabel}</button>
          </div>
        </div>
        <div className="metrics" aria-label="Training metrics">
          <div className="metric"><span className="metric-icon lavender"><Flag aria-hidden="true" /></span><div><span>Episodes completed</span><strong data-testid="episodes">{completed}<small> / {config?.episodes ?? '—'}</small></strong></div></div>
          <div className="metric"><span className="metric-icon blue"><Target aria-hidden="true" /></span><div><span>Success rate</span><strong>{completed ? `${Math.round(wins / completed * 100)}%` : '—'}</strong></div></div>
          <div className="metric"><span className="metric-icon lime"><Gauge aria-hidden="true" /></span><div><span>Exploration (ε)</span><strong>{fixed(snapshot?.epsilon ?? config?.epsilon)}</strong></div></div>
          <div className="metric"><span className="metric-icon amber"><Activity aria-hidden="true" /></span><div><span>Total steps</span><strong data-testid="total-steps">{(snapshot?.total_steps ?? 0).toLocaleString('en-US')}</strong></div></div>
        </div>
        <div className="panel-grid">
          {experiment ? <Maze experiment={experiment} snapshot={snapshot} selected={selected} onSelect={setSelected} /> : <div className="panel loading-panel">Loading maze…</div>}
          <Inspector snapshot={snapshot} selected={selected} />
        </div>
      </section>
      <div className="panel-grid lower-grid" id="metrics">
        <section className="panel" aria-labelledby="performance-heading">
          <div className="panel-heading chart-heading"><div><h2 id="performance-heading">Episode return</h2><p>Total reward earned per episode</p></div><div className="chart-legend"><span>Return</span><span>10-episode avg.</span></div></div>
          <Suspense fallback={<div className="chart" />}><Performance history={snapshot?.history ?? emptyHistory} /></Suspense>
        </section>
        <EventFeed events={state.events} />
      </div>
      <footer className="footer"><span><FlaskConical aria-hidden="true" /> MazeLab</span><a href="/api/docs" target="_blank" rel="noreferrer">API documentation <ArrowDownRight aria-hidden="true" /></a></footer>
    </main>
    <dialog className="dialog" ref={confirmation} aria-label="Replace current training run">
      <div className="dialog-heading"><h2>Replace current run?</h2><button className="button icon-button" aria-label="Close dialog" onClick={() => confirmation.current?.close()}><X aria-hidden="true" /></button></div>
      <p className="dialog-intro">Starting over replaces the current Q-table and saved progress.</p>
      <div className="dialog-actions"><button className="button secondary" autoFocus onClick={() => confirmation.current?.close()}>Cancel</button>
        <button className="button primary" onClick={() => { if (replacement) apply(replacement); confirmation.current?.close() }}>Start fresh</button></div>
    </dialog>
  </>
}
