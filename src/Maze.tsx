import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bot, Flag, LocateFixed } from 'lucide-react'
import { useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import type { Experiment, Position, Snapshot } from './protocol'

export const actionIcons = [ArrowUp, ArrowRight, ArrowDown, ArrowLeft]
export const actionNames = ['Up', 'Right', 'Down', 'Left']
export const coordinate = ([row, column]: Position) => `${String.fromCharCode(65 + column)}${row + 1}`
export const equals = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1]
const indexOf = ([row, column]: Position) => row * 9 + column
const overlays = ['Maze', 'Q-values', 'Policy'] as const
type Overlay = (typeof overlays)[number]

export default function Maze({ experiment, snapshot, selected, onSelect }: {
  experiment: Experiment
  snapshot: Snapshot | null
  selected: Position | null
  onSelect: (position: Position | null) => void
}) {
  const [overlay, setOverlay] = useState<Overlay>('Maze')
  const buttons = useRef(new Map<number, HTMLButtonElement>())
  const agent: Position = snapshot?.state ?? [0, 0]
  const active = selected ?? agent
  const visited = new Set(snapshot?.trail.map(indexOf))
  const keyOffsets: Partial<Record<string, Position>> = { ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowDown: [1, 0], ArrowLeft: [0, -1] }

  function move(event: KeyboardEvent, [row, column]: Position) {
    const offset = keyOffsets[event.key]
    if (!offset) return
    event.preventDefault()
    let next: Position = [row + offset[0], column + offset[1]]
    while (experiment.rows[next[0]]?.[next[1]] === '#') next = [next[0] + offset[0], next[1] + offset[1]]
    if (!experiment.rows[next[0]]?.[next[1]]) return
    onSelect(next)
    buttons.current.get(indexOf(next))?.focus()
  }

  return <section className="panel maze-panel" aria-labelledby="maze-heading">
    <div className="panel-heading maze-heading">
      <div><h2 id="maze-heading">Maze environment</h2><p>{experiment.name} · 9 columns × 8 rows</p></div>
      <div className="segmented" role="group" aria-label="Maze overlay">
        {overlays.map(label => <button key={label} aria-pressed={overlay === label} onClick={() => setOverlay(label)}>{label}</button>)}
      </div>
    </div>
    <div className="board-stage">
      <div className="maze-coordinates">
        <div className="x-axis" aria-hidden="true">{'ABCDEFGHI'.split('').map(letter => <span key={letter}>{letter}</span>)}</div>
        <div className="y-axis" aria-hidden="true">{experiment.rows.map((_, row) => <span key={row}>{row + 1}</span>)}</div>
        <div className="maze-grid" role="group" aria-label="Maze cells. Use arrow keys to move between selectable cells.">
          {experiment.rows.flatMap((line, row) => Array.from(line, (tile, column) => {
            const position: Position = [row, column]
            const index = indexOf(position)
            const values = snapshot?.q[index] ?? [0, 0, 0, 0]
            const best = Math.max(...values)
            const known = values.some(value => value !== 0)
            const PolicyArrow = actionIcons[values.indexOf(best)]
            const isAgent = equals(agent, position)
            const isSelected = selected !== null && equals(selected, position)
            const isVisited = visited.has(index) && overlay === 'Maze'
            const heat = Math.min(Math.abs(best) * 0.7, 0.7)
            const shade = overlay === 'Q-values' && known ? { '--heat': heat, '--heat-rgb': best < 0 ? '225 119 110' : '126 191 255' } as CSSProperties : undefined
            if (tile === '#') return <div key={index} className="cell wall" aria-hidden="true" />
            const name = [coordinate(position), tile === 'S' ? 'start' : tile === 'G' ? 'goal' : 'open', isAgent ? 'agent' : null].filter(Boolean).join(', ')
            return <button
              key={index} ref={button => { if (button) buttons.current.set(index, button); else buttons.current.delete(index) }}
              className={`cell${tile === 'S' ? ' start' : ''}${tile === 'G' ? ' goal' : ''}${isVisited ? ' visited' : ''}${isAgent ? ' agent' : ''}${isSelected ? ' selected' : ''}`}
              aria-label={name} aria-pressed={isSelected} tabIndex={equals(active, position) ? 0 : -1} style={shade}
              onClick={() => onSelect(position)} onKeyDown={event => move(event, position)}
            >
              {isAgent ? <span className="agent-marker"><Bot aria-hidden="true" /></span>
                : tile === 'G' ? <Flag aria-hidden="true" className="goal-icon" />
                : tile === 'S' ? <LocateFixed aria-hidden="true" className="start-icon" />
                : overlay === 'Policy' && known ? <PolicyArrow aria-hidden="true" className="policy-icon" />
                : overlay === 'Q-values' && known ? <span className="heat-value">{best.toFixed(2)}</span>
                : <span className="cell-dot" />}
            </button>
          }))}
        </div>
      </div>
    </div>
    <div className="maze-footer">
      <ul className="legend" aria-label="Maze legend">
        <li><span className="legend-agent" />Agent</li><li><span className="legend-goal" />Goal</li>
        <li><span className="legend-wall" />Wall</li><li><span className="legend-visited" />Visited</li>
      </ul>
      <button className="text-button" onClick={() => onSelect(null)} disabled={selected === null}>Follow agent</button>
    </div>
  </section>
}
