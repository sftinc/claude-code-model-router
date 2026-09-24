import type { Args, On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

/** What the world beneath the mod saw and said. */
export type World = {
  clock: MockClock
  lines: string[]
  steps: { model: string; effort: unknown; hasEffort: boolean }[]
  spawned: (string | undefined)[]
  classified: number
}

/**
 * The engine beneath the mod: a clock that moves only when told, a log that is
 * kept, session history (or a failure to read it), the built-in classifier's
 * answer (optionally late), and the event chains' bottoms, which record what
 * reached them.
 */
export function worldOf(
  on: On,
  answers: { label?: string; labelAfterMs?: number; history?: 'fail' } = {},
): World {
  const clock = mock.clock(on)
  const world: World = { clock, lines: [], steps: [], spawned: [], classified: 0 }

  on('ui.log', ($, e) => {
    world.lines.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.messages', () => {
    if (answers.history === 'fail') throw new Error('history unavailable')
    return { value: [] }
  })
  on('model.classify', async () => {
    world.classified += 1
    if (answers.labelAfterMs) await clock.sleep(answers.labelAfterMs)
    return { value: answers.label }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    world.steps.push({ model: e.model, effort: e.effort, hasEffort: 'effort' in e })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('agent.spawn', ($, e) => {
    world.spawned.push(e.model)
    return { model: e.model ?? e.parentModel }
  })
  return world
}

export function promptOf(text: string): Args<'prompt.submit'> {
  return { text, wait: false, origin: { kind: 'composer' } }
}

export function stepOf(turnId: string, index: number, model: string, effort?: 'low' | 'medium' | 'high' | 'xhigh'): Args<'turn.step'> {
  return { turnId, index, model, messageCount: 1, ...(effort === undefined ? {} : { effort }) }
}

export function spawnOf(overrides: Partial<Args<'agent.spawn'>> = {}): Args<'agent.spawn'> {
  return {
    tool_use_id: 'toolu_1',
    prompt: 'Find every caller of fetchUser and list the files',
    description: 'Find callers',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-sonnet-5',
    background: false,
    fork: false,
    ...overrides,
  } as Args<'agent.spawn'>
}

/** Runs a turn.step stream to its end. */
export async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // each chunk is only passed through
  }
}
