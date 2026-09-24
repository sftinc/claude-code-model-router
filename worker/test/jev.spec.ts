import { describe, expect, test, vi } from 'vitest'
import { jev, parseAnswers, QUESTIONS } from '../src/classifiers/jev'
import type { Env, GatewayOptions } from '../src/types'

const GATEWAY: GatewayOptions = { id: 'model-router', skipCache: true, collectLog: true, metadata: {} }

const answer = (overrides: Record<string, unknown> = {}) => ({
  model: 'jev-1.13.0',
  answers: {
    tier: { type: 'choice', choice: 'balanced', probabilities: { fast: 0.1, balanced: 0.8, deep: 0.1 }, confidence: 0.7 },
    effort: { type: 'score', score: 1.9, probabilities: { '0': 0.05, '1': 0.2, '2': 0.6, '3': 0.15 }, legend: {}, confidence: 0.47 },
    risky: { type: 'noul', noul: 0.04 },
    ...overrides,
  },
  usage: { inputTokens: 100, outputTokens: 0 },
})

const envAnswering = (result: unknown): Env => ({
  AI: { run: vi.fn(async () => result), aiGatewayLogId: 'log-1' },
  ROUTER_SECRET: 's',
  GATEWAY_ID: 'model-router',
  CF_VERSION_METADATA: { id: 'v1' },
})

describe('jev adapter', () => {
  test('asks typesafe/jev with the situation as state and all three questions', async () => {
    const env = envAnswering(answer())
    await jev.classify({ source: 'main', prompt: 'go' }, env, GATEWAY)
    expect(env.AI.run).toHaveBeenCalledWith(
      'typesafe/jev',
      { state: { source: 'main', prompt: 'go' }, questions: QUESTIONS },
      { gateway: GATEWAY },
    )
  })

  test('normalizes a complete answer into a verdict naming Jev and its version', async () => {
    const verdict = await jev.classify({ source: 'main', prompt: 'go' }, envAnswering(answer()), GATEWAY)
    expect(verdict).toEqual({
      classifier: 'typesafe/jev@jev-1.13.0',
      tier: { value: 'balanced', confidence: 0.7 },
      effort: { level: 2, confidence: 0.47 },
      risky: { p: 0.04 },
    })
  })

  test('effort is the most probable level, a tie going higher', async () => {
    const tie = answer({ effort: { type: 'score', score: 1, probabilities: { '0': 0.5, '2': 0.5 }, confidence: 0 } })
    const verdict = await jev.classify({ source: 'main', prompt: 'go' }, envAnswering(tie), GATEWAY)
    expect(verdict.effort.level).toBe(2)
  })

  test('a missing confidence is computed from the probabilities over every option asked', async () => {
    const bare = answer({ tier: { type: 'choice', choice: 'fast', probabilities: { fast: 0.61, balanced: 0.2, deep: 0.19 } } })
    const verdict = await jev.classify({ source: 'main', prompt: 'go' }, envAnswering(bare), GATEWAY)
    expect(verdict.tier.confidence).toBeCloseTo(0.415, 3)
  })

  test('the risky question is asked about the act, not the subject', () => {
    expect(QUESTIONS.risky.instructions).toContain('not its subject')
    expect(QUESTIONS.effort.criteria).toHaveLength(4)
  })
})

describe('parseAnswers', () => {
  test("reads the answer out of AI Gateway's completed envelope", () => {
    const parsed = parseAnswers({ state: 'Completed', result: answer(), gatewayMetadata: { keySource: 'Unified' } })
    expect(parsed.model).toBe('jev-1.13.0')
    expect(parsed.tier.choice).toBe('balanced')
  })

  test('refuses an envelope whose state is not Completed', () => {
    expect(() => parseAnswers({ state: 'Running', result: answer() })).toThrow('state: Running')
  })

  test('refuses a wrapped or shapeless response', () => {
    expect(() => parseAnswers({ result: answer() })).toThrow()
    expect(() => parseAnswers(null)).toThrow()
  })

  test('refuses a missing tier or an unknown choice', () => {
    expect(() => parseAnswers(answer({ tier: undefined }))).toThrow()
    expect(() => parseAnswers(answer({ tier: { choice: 'other', probabilities: { other: 1 } } }))).toThrow()
  })

  test('refuses effort probabilities keyed by anything but "0".."3"', () => {
    expect(() => parseAnswers(answer({ effort: { probabilities: { low: 1 } } }))).toThrow()
    expect(() => parseAnswers(answer({ effort: { probabilities: { '4': 1 } } }))).toThrow()
    expect(() => parseAnswers(answer({ effort: { probabilities: {} } }))).toThrow()
  })

  test('refuses a risky value outside 0..1', () => {
    expect(() => parseAnswers(answer({ risky: { noul: 1.2 } }))).toThrow()
  })

  test('ignores a reported confidence outside 0..1, so it is computed instead', () => {
    const odd = parseAnswers(answer({ tier: { choice: 'deep', probabilities: { deep: 1 }, confidence: 7 } }))
    expect(odd.tier.confidence).toBeNull()
  })
})
