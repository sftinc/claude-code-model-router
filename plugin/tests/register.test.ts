/**
 * Hook-level tests for the API path: `register` is called directly, with a
 * recording `on` and a hand-built `$`, bypassing the full plugin-loading
 * harness so a fetch response, a timeout race or a history failure can be
 * driven exactly.
 */
import { describe, expect, test } from 'claude-code/testing'

import { register } from '../hooks/model-router.ts'
import { drain } from './fixtures/world.ts'

type FetchAnswer = { ok: boolean; status: number; headers: Record<string, string>; text: string }

/** Captures the three handlers `register` wires, by event name. */
function recordHandlers() {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const on = ((name: string, hook: (...args: unknown[]) => unknown) => {
    handlers[name] = hook
    return undefined
  }) as unknown as Parameters<typeof register>[0]
  return { on, handlers }
}

/** A hand-built `$`: fetch, sleep and session.messages are the parts a test drives. */
function makeDollar(
  parts: {
    fetch?: () => Promise<FetchAnswer>
    sleep?: (ms: number) => Promise<void>
    messages?: () => unknown[]
  } = {},
) {
  const logs: string[] = []
  const statuses: (string | undefined)[] = []
  let clock = 0
  const calls: { url?: string; init?: { headers?: Record<string, string>; body?: string }; fetches: number } = {
    fetches: 0,
  }
  const $ = {
    http: {
      fetch: async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
        calls.url = url
        calls.init = init
        calls.fetches += 1
        return parts.fetch ? parts.fetch() : { ok: true, status: 200, headers: {}, text: '' }
      },
    },
    clock: {
      now: async () => clock++,
      // Never resolves unless a test overrides it: a fetch that does resolve
      // must always win the race, whatever the two mocks' microtask timing.
      sleep: (ms: number) => (parts.sleep ? parts.sleep(ms) : new Promise<void>(() => undefined)),
      // Runs the timer's function at once; the warm-up is the only caller.
      after: (_ms: number, fn: () => void) => {
        fn()
        return { cancel: () => undefined }
      },
    },
    session: {
      messages: async () => (parts.messages ? parts.messages() : []),
    },
    model: {
      classify: async () => undefined,
    },
    ui: {
      log: (text: string) => {
        logs.push(text)
      },
      status: (text: string | undefined) => {
        statuses.push(text)
      },
    },
  }
  return { $: $ as unknown as Parameters<Parameters<typeof register>[0]>[0], logs, statuses, calls }
}

const promptOf = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } })

const stepOf = (turnId: string, index: number, model: string, effort?: 'low' | 'medium' | 'high' | 'xhigh') => ({
  turnId,
  index,
  model,
  messageCount: 1,
  ...(effort === undefined ? {} : { effort }),
})

const verdict = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    classifier: 'jev',
    tier: { value: 'balanced', confidence: 0.9 },
    effort: { level: 3, confidence: 0.9 },
    risky: { p: 0 },
    ...patch,
  })

const promptNext = async (e: unknown) => e

/** Drives a `turn.step` call to its end and returns what reached `next`. */
async function stepThrough(handlers: Record<string, (...args: unknown[]) => unknown>, $: unknown, e: ReturnType<typeof stepOf>) {
  let received: Record<string, unknown> = {}
  const stepNext = async function* (input: Record<string, unknown>) {
    received = input
    return { turnId: input.turnId, index: input.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  }
  await drain((handlers['turn.step'] as (...a: unknown[]) => AsyncIterable<unknown>)($, e, stepNext))
  return received
}

const OPTIONS = { provider: 'api', apiUrl: 'https://router.test', apiSecret: 's', routeMainModel: true }

describe('register', () => {
  test('a 200 verdict with effort level 3 at 0.9 applies xhigh to a Sonnet/low step', async () => {
    const { on, handlers } = recordHandlers()
    register(on, OPTIONS)
    const { $ } = makeDollar({ fetch: async () => ({ ok: true, status: 200, headers: {}, text: verdict() }) })

    await (handlers['prompt.submit'] as (...a: unknown[]) => Promise<unknown>)($, promptOf('rename getUser'), promptNext)
    const received = await stepThrough(handlers, $, stepOf('t1', 0, 'claude-sonnet-5', 'low'))

    expect(received.model).toBe('claude-sonnet-5')
    expect(received.effort).toBe('xhigh')
  })

  test('a 401 is logged with its status and the step passes through unchanged', async () => {
    const { on, handlers } = recordHandlers()
    register(on, OPTIONS)
    const { $, logs } = makeDollar({ fetch: async () => ({ ok: false, status: 401, headers: {}, text: '' }) })

    await (handlers['prompt.submit'] as (...a: unknown[]) => Promise<unknown>)($, promptOf('rename getUser'), promptNext)
    const received = await stepThrough(handlers, $, stepOf('t1', 0, 'claude-sonnet-5', 'medium'))

    expect(logs.some((line) => line.includes('HTTP 401'))).toBe(true)
    expect(received.model).toBe('claude-sonnet-5')
    expect(received.effort).toBe('medium')
  })

  test('a malformed verdict logs "malformed verdict" and the step passes through unchanged', async () => {
    const { on, handlers } = recordHandlers()
    register(on, OPTIONS)
    const { $, logs } = makeDollar({ fetch: async () => ({ ok: true, status: 200, headers: {}, text: '{nope' }) })

    await (handlers['prompt.submit'] as (...a: unknown[]) => Promise<unknown>)($, promptOf('rename getUser'), promptNext)
    const received = await stepThrough(handlers, $, stepOf('t1', 0, 'claude-sonnet-5', 'medium'))

    expect(logs.some((line) => line.includes('malformed verdict'))).toBe(true)
    expect(received.model).toBe('claude-sonnet-5')
    expect(received.effort).toBe('medium')
  })

  test('a never-resolving fetch is passed by the timeout and stores no decision', async () => {
    const { on, handlers } = recordHandlers()
    register(on, OPTIONS)
    const { $, logs } = makeDollar({
      fetch: () => new Promise<FetchAnswer>(() => undefined),
      sleep: async () => undefined,
    })

    await (handlers['prompt.submit'] as (...a: unknown[]) => Promise<unknown>)($, promptOf('rename getUser'), promptNext)
    expect(logs.some((line) => line.includes('within 2000ms'))).toBe(true)

    const received = await stepThrough(handlers, $, stepOf('t1', 0, 'claude-sonnet-5', 'medium'))
    expect(received.model).toBe('claude-sonnet-5')
    expect(received.effort).toBe('medium')
  })

  test('routeMainModel rewrites a Sonnet/high step to Haiku and clears its effort explicitly', async () => {
    const { on, handlers } = recordHandlers()
    register(on, OPTIONS)
    const { $ } = makeDollar({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: {},
        text: verdict({ tier: { value: 'fast', confidence: 0.9 }, effort: { level: 1, confidence: 0.9 } }),
      }),
    })

    await (handlers['prompt.submit'] as (...a: unknown[]) => Promise<unknown>)($, promptOf('rename getUser'), promptNext)
    const received = await stepThrough(handlers, $, stepOf('t1', 0, 'claude-sonnet-5', 'high'))

    expect(received.model).toBe('claude-haiku-4-5-20251001')
    expect('effort' in received).toBe(true)
    expect(received.effort).toBeUndefined()
  })

  test('the status line shows a change and is cleared by a turn sent as is', async () => {
    const { on, handlers } = recordHandlers()
    register(on, OPTIONS)
    let ok = true
    const { $, statuses } = makeDollar({
      fetch: async () => ({ ok, status: ok ? 200 : 401, headers: {}, text: ok ? verdict() : '' }),
    })

    await (handlers['prompt.submit'] as (...a: unknown[]) => Promise<unknown>)($, promptOf('first'), promptNext)
    await stepThrough(handlers, $, stepOf('t1', 0, 'claude-sonnet-5', 'low'))
    ok = false
    await (handlers['prompt.submit'] as (...a: unknown[]) => Promise<unknown>)($, promptOf('second'), promptNext)
    await stepThrough(handlers, $, stepOf('t2', 0, 'claude-sonnet-5', 'low'))

    expect(statuses).toEqual(['router balanced@0.90 ⇒ xhigh', undefined])
  })

  test('unreadable history yields a raise-only verdict line and logs the history failure once across two prompts', async () => {
    const { on, handlers } = recordHandlers()
    register(on, OPTIONS)
    const { $, logs } = makeDollar({
      fetch: async () => ({ ok: true, status: 200, headers: {}, text: verdict() }),
      messages: () => {
        throw new Error('unavailable')
      },
    })

    await (handlers['prompt.submit'] as (...a: unknown[]) => Promise<unknown>)($, promptOf('first'), promptNext)
    await (handlers['prompt.submit'] as (...a: unknown[]) => Promise<unknown>)($, promptOf('second'), promptNext)

    expect(logs.filter((line) => line.includes('session history unavailable'))).toHaveLength(1)
    expect(logs.filter((line) => line.startsWith('[model-router] verdict via') && line.includes('raise-only'))).toHaveLength(2)
  })

  test('the POST goes to the classify endpoint with the bearer secret and a main-source body', async () => {
    const { on, handlers } = recordHandlers()
    register(on, OPTIONS)
    const { $, calls } = makeDollar({ fetch: async () => ({ ok: true, status: 200, headers: {}, text: verdict() }) })

    await (handlers['prompt.submit'] as (...a: unknown[]) => Promise<unknown>)($, promptOf('rename getUser to fetchUser'), promptNext)

    expect(calls.url).toBe('https://router.test/v1/classify')
    expect(calls.init?.headers?.authorization).toBe('Bearer s')
    const body = JSON.parse(calls.init?.body ?? '{}')
    expect(body.source).toBe('main')
    expect(body.prompt).toBe('rename getUser to fetchUser')
  })

  describe('warm-up', () => {
    const startOf = (isInteractive: boolean) => ({ cwd: '/tmp', surface: null, isInteractive })
    const startNext = async (e: { cwd: string }) => ({ cwd: e.cwd })
    const start = (handlers: Record<string, (...a: unknown[]) => unknown>, $: unknown, isInteractive: boolean) =>
      (handlers['session.start'] as (...a: unknown[]) => Promise<unknown>)($, startOf(isInteractive), startNext)

    test('an interactive session start sends one throwaway classification to the api', async () => {
      const { on, handlers } = recordHandlers()
      register(on, OPTIONS)
      const { $, calls } = makeDollar()

      await start(handlers, $, true)
      expect(calls.fetches).toBe(1)
      expect(calls.url).toBe('https://router.test/v1/classify')
      expect(calls.init?.headers?.authorization).toBe('Bearer s')
      expect(JSON.parse(calls.init?.body ?? '{}')).toEqual({ source: 'main', prompt: 'warm-up' })
    })

    test('a -p run, warmUp off, or no api configured sends nothing', async () => {
      for (const [options, isInteractive] of [
        [OPTIONS, false],
        [{ ...OPTIONS, warmUp: false }, true],
        [{ provider: 'builtin' }, true],
      ] as const) {
        const { on, handlers } = recordHandlers()
        register(on, options)
        const { $, calls } = makeDollar()
        await start(handlers, $, isInteractive)
        expect(calls.fetches).toBe(0)
      }
    })

    test('a failed warm-up is swallowed', async () => {
      const { on, handlers } = recordHandlers()
      register(on, OPTIONS)
      const { $, logs } = makeDollar({ fetch: async () => Promise.reject(new Error('offline')) })

      await start(handlers, $, true)
      expect(logs).toEqual([])
    })
  })
})
