import { z } from 'zod/mini'

const bounded = (min: number, max: number) => z.number().check(z.gte(min), z.lte(max))
const integer = (min: number, max: number) => z.int().check(z.gte(min), z.lte(max))
const maze = z.enum(['switchback', 'crossroads', 'courtyard'])
const state = z.tuple([integer(0, 7), integer(0, 8)])
const action = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
const number = z.number()
const rate = bounded(0, 1)

export const configSchema = z.object({
  maze,
  episodes: integer(1, 2000),
  max_steps: integer(10, 500),
  alpha: rate.check(z.gt(0)),
  gamma: rate,
  epsilon: rate,
  epsilon_min: rate,
  epsilon_decay: rate.check(z.gt(0)),
  seed: integer(0, 2 ** 32 - 1),
}).check(z.refine(config => config.epsilon_min <= config.epsilon))

const transition = z.object({
  state, action, reward: number, next_state: state,
  q_before: number, td_target: number, td_error: number, q_after: number,
  episode: integer(1, 2000), step: integer(1, 500), terminal: z.boolean(),
  explored: z.boolean(), epsilon: rate,
})

const digits = z.string().check(z.regex(/^\d{1,39}$/))
export const snapshotSchema = z.object({
  version: z.literal(1), config: configSchema,
  q: z.array(z.tuple([number, number, number, number])).check(z.length(72)),
  completed: integer(0, 2000), wins: integer(0, 2000), total_steps: integer(0, 1_000_000),
  episode_steps: integer(0, 500), episode_reward: number, epsilon: rate, state,
  trail: z.array(state).check(z.minLength(1), z.maxLength(501)),
  history: z.array(z.object({ episode: integer(1, 2000), steps: integer(1, 500), reward: number, success: z.boolean() })).check(z.maxLength(80)),
  last: z.nullable(transition),
  rng: z.object({ state: digits, inc: digits, has_uint32: integer(0, 1), uinteger: integer(0, 2 ** 32 - 1) }),
})

export const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), snapshot: snapshotSchema }),
  z.object({ type: z.literal('batch'), snapshot: snapshotSchema, events: z.array(transition).check(z.maxLength(8)) }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

export const catalogSchema = z.array(z.object({
  id: maze, name: z.string(), rows: z.array(z.string().check(z.regex(/^[S.G#]{9}$/))).check(z.length(8)),
  config: configSchema,
})).check(z.minLength(1))

export type Config = z.infer<typeof configSchema>
export type Snapshot = z.infer<typeof snapshotSchema>
export type Transition = z.infer<typeof transition>
export type Position = z.infer<typeof state>
export type Experiment = z.infer<typeof catalogSchema>[number]
