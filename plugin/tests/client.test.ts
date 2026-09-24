import { describe, expect, test } from 'claude-code/testing'

import { buildRecent, builtinDecision, endpoint, readVerdict, requestHeaders, selectProvider } from '../hooks/client.ts'
import type { SessionEntry } from '../hooks/client.ts'

const VERDICT = {
  classifier: 'typesafe/jev@jev-1.13.0',
  tier: { value: 'balanced', confidence: 0.82 },
  effort: { level: 2, confidence: 0.61 },
  risky: { p: 0.04 },
}

const verdictWith = (patch: (v: Record<string, unknown>) => void) => {
  const copy = JSON.parse(JSON.stringify(VERDICT)) as Record<string, unknown>
  patch(copy)
  return JSON.stringify(copy)
}

const said = (role: 'user' | 'assistant', text: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  role,
  text,
  toolUses: [],
  ...extra,
})

describe('client', () => {
  test('builtin ignores the API; auto and api need both the URL and the secret', () => {
    expect(selectProvider('builtin', 'https://x', 's')).toBeNull()
    expect(selectProvider('auto', 'https://x', 's')).toBe('api')
    expect(selectProvider('auto', 'https://x', '')).toBeNull()
    expect(selectProvider('api', '', 's')).toBeNull()
    expect(selectProvider('api', 'https://x', 's')).toBe('api')
  })

  test('the endpoint joins the base URL whatever its trailing slashes', () => {
    expect(endpoint('https://model-router-api.x.workers.dev')).toBe('https://model-router-api.x.workers.dev/v1/classify')
    expect(endpoint('https://model-router-api.x.workers.dev//')).toBe('https://model-router-api.x.workers.dev/v1/classify')
  })

  test('endpoint tolerates a pasted full endpoint', () => {
    expect(endpoint('https://x.test/v1/classify/')).toBe('https://x.test/v1/classify')
  })

  test('the request carries the secret as a bearer token', () => {
    expect(requestHeaders('s3cret')).toEqual({ 'content-type': 'application/json', authorization: 'Bearer s3cret' })
  })

  test('a complete verdict reads as a decision', () => {
    expect(readVerdict(JSON.stringify(VERDICT))).toEqual({
      tier: 'balanced',
      confidence: 0.82,
      effort: 2,
      effortConfidence: 0.61,
      risky: 0.04,
      classifier: 'typesafe/jev@jev-1.13.0',
      upOnly: false,
    })
  })

  test('null confidences are accepted', () => {
    const text = verdictWith((v) => {
      ;(v.tier as Record<string, unknown>).confidence = null
      ;(v.effort as Record<string, unknown>).confidence = null
    })
    expect(readVerdict(text)?.confidence).toBeNull()
  })

  test('a verdict with a missing field or a value out of bounds is rejected', () => {
    expect(readVerdict('{nope')).toBeNull()
    expect(readVerdict(verdictWith((v) => delete v.classifier))).toBeNull()
    expect(readVerdict(verdictWith((v) => ((v.tier as Record<string, unknown>).value = 'other')))).toBeNull()
    expect(readVerdict(verdictWith((v) => ((v.effort as Record<string, unknown>).level = 1.5)))).toBeNull()
    expect(readVerdict(verdictWith((v) => ((v.effort as Record<string, unknown>).level = 4)))).toBeNull()
    expect(readVerdict(verdictWith((v) => ((v.tier as Record<string, unknown>).confidence = 1.2)))).toBeNull()
    expect(readVerdict(verdictWith((v) => delete v.risky))).toBeNull()
    expect(readVerdict(verdictWith((v) => ((v.risky as Record<string, unknown>).p = -0.1)))).toBeNull()
  })

  test('the built-in classifier gives a tier with no confidence, effort or risk', () => {
    expect(builtinDecision('deep')).toEqual({
      tier: 'deep',
      confidence: null,
      risky: null,
      effort: null,
      effortConfidence: null,
      classifier: null,
      upOnly: false,
    })
    expect(builtinDecision('nonsense')).toBeNull()
    expect(builtinDecision(undefined)).toBeNull()
  })

  test('contextMessages 0 sends no recent at all', () => {
    expect(buildRecent([said('user', 'a')], 'go', 0, 6000)).toBeUndefined()
  })

  test('a trailing copy of the prompt is dropped, and only the last n messages are kept', () => {
    const messages = [said('user', 'one'), said('assistant', 'two'), said('user', 'three'), said('user', 'ok, go ahead')]
    expect(buildRecent(messages, 'ok, go ahead', 2, 6000)).toEqual([
      { role: 'assistant', text: 'two' },
      { role: 'user', text: 'three' },
    ])
  })

  test('a tool call becomes its name and the first line of its result, found in any message', () => {
    const messages = [
      said('assistant', 'Running the tests.', { toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: {} }] }),
      said('user', '', { toolResults: [{ tool_use_id: 't1', text: '\n3 passed, 1 failed\nmore', isError: false }] }),
    ]
    expect(buildRecent(messages, 'fix it', 6, 6000)).toEqual([
      { role: 'assistant', text: 'Running the tests.\n[Bash] 3 passed, 1 failed' },
    ])
  })

  test('a failed tool call is marked as an error', () => {
    const messages = [
      said('assistant', '', {
        toolUses: [{ tool_use_id: 't1', tool: 'Read', input: {} }],
        toolResults: [{ tool_use_id: 't1', text: 'ENOENT: no such file', isError: true }],
      }),
    ]
    expect(buildRecent(messages, 'go', 6, 6000)).toEqual([{ role: 'assistant', text: '[Read] error: ENOENT: no such file' }])
  })

  test('a tool call with no result yet is marked, not dropped', () => {
    const messages = [said('assistant', 'Starting.', { toolUses: [{ tool_use_id: 't9', tool: 'Bash', input: {} }] })]
    expect(buildRecent(messages, 'go', 6, 6000)).toEqual([{ role: 'assistant', text: 'Starting.\n[Bash] no result' }])
  })

  test('empty reductions are filtered before the n-message slice, not after', () => {
    const messages = [
      said('user', 'a'),
      said('assistant', ''),
      said('user', 'b'),
      said('assistant', ''),
      said('user', 'c'),
      said('assistant', ''),
    ]
    expect(buildRecent(messages, 'go', 3, 6000)).toEqual([
      { role: 'user', text: 'a' },
      { role: 'user', text: 'b' },
      { role: 'user', text: 'c' },
    ])
  })

  test('over the character budget, the oldest messages go first; a lone long one keeps its end', () => {
    const messages = [said('user', 'a'.repeat(50)), said('assistant', 'b'.repeat(50))]
    expect(buildRecent(messages, 'go', 6, 60)).toEqual([{ role: 'assistant', text: 'b'.repeat(50) }])
    expect(buildRecent([said('assistant', `${'x'.repeat(100)}END`)], 'go', 6, 10)).toEqual([
      { role: 'assistant', text: 'xxxxxxxEND' },
    ])
  })
})
