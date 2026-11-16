import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Snapshot } from './protocol'

const emptyAxis = [{ episode: 1 }, { episode: 10 }, { episode: 20 }, { episode: 30 }, { episode: 40 }]

export default function Performance({ history }: { history: Snapshot['history'] }) {
  const records = history.map((item, index) => {
    const sample = history.slice(Math.max(0, index - 9), index + 1)
    return {
      ...item,
      reward: Number(item.reward.toFixed(2)),
      trend: Number((sample.reduce((sum, episode) => sum + episode.reward, 0) / sample.length).toFixed(2)),
    }
  })
  const rewards = records.flatMap(record => [record.reward, record.trend])
  const domain = rewards.length ? [Math.floor(Math.min(0, ...rewards)), Math.ceil(Math.max(1, ...rewards))] : [-10, 2]
  return <div className="chart" aria-label={history.length ? `Episode return. Latest return ${history.at(-1)?.reward.toFixed(2)}.` : 'Complete an episode to see its return.'}>
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={history.length ? records : emptyAxis} margin={{ top: 12, right: 14, bottom: 6, left: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="4 5" vertical={false} />
        <XAxis dataKey="episode" stroke="var(--muted)" tickLine={false} axisLine={false} tickMargin={9} minTickGap={24} />
        <YAxis stroke="var(--muted)" tickLine={false} axisLine={false} width={42} domain={domain} tickFormatter={value => Number(value.toFixed(2)).toString()} />
        <Tooltip labelFormatter={value => `Episode ${value}`} contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10 }} />
        <Line name="Return" dataKey="reward" type="linear" stroke="var(--chart-secondary)" strokeWidth={1.5} dot={history.length === 1} isAnimationActive={false} />
        <Line name="10-episode average" dataKey="trend" type="monotone" stroke="var(--accent)" strokeWidth={2.25} dot={history.length === 1} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
    {history.length === 0 && <div className="chart-empty">Complete an episode to start charting returns.</div>}
  </div>
}
