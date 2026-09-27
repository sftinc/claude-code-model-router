/**
 * The Jev adapter: the only file that knows Jev's answer shapes. The questions
 * are in jev-questions.ts.
 *
 * Per Cloudflare's model page, `env.AI.run('typesafe/jev', …)` returns the bare
 * `{ model, answers, usage }`, and a score's probabilities are keyed by level
 * index as a string ("0".."3"). Anything else throws, which the Worker turns
 * into a 502 and the mod into "request unchanged".
 */
import { argmaxHigh, confidenceOf } from '../confidence'
import type { Classifier, EffortLevel, Tier } from '../types'
import { QUESTIONS } from './jev-questions'

const TIERS: readonly Tier[] = ['fast', 'balanced', 'deep']

type Answer = { probabilities: Record<string, number>; confidence: number | null }

export type Parsed = {
  model: string
  tier: Answer & { choice: Tier }
  effort: Answer
  risky: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUnit = (value: unknown): value is number => typeof value === 'number' && value >= 0 && value <= 1

const isProbabilities = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every(isUnit)

const confidenceField = (value: unknown): number | null => (isUnit(value) ? value : null)

/**
 * The answer inside the binding's response. Through AI Gateway the binding
 * returns `{ state: 'Completed', result: { model, answers, usage } }`; the bare
 * inner shape is accepted too. Any other state is a failure.
 */
function unwrap(response: unknown): unknown {
  if (!isRecord(response) || !('state' in response)) return response
  if (response.state !== 'Completed') throw new Error(`jev: request not completed (state: ${String(response.state)})`)
  return response.result
}

/** Jev's answer, checked field by field; throws on anything the adapter can't normalize. */
export function parseAnswers(response: unknown): Parsed {
  const result = unwrap(response)
  if (!isRecord(result) || typeof result.model !== 'string' || !isRecord(result.answers)) {
    throw new Error(`jev: unexpected response shape: ${String(JSON.stringify(response)).slice(0, 400)}`)
  }
  const { tier, effort, risky } = result.answers
  if (!isRecord(tier) || !TIERS.includes(tier.choice as Tier) || !isProbabilities(tier.probabilities)) {
    throw new Error('jev: bad tier answer')
  }
  if (
    !isRecord(effort) ||
    !isProbabilities(effort.probabilities) ||
    !Object.keys(effort.probabilities).every((key) => /^[0-3]$/.test(key))
  ) {
    throw new Error('jev: bad effort answer')
  }
  if (!isRecord(risky) || !isUnit(risky.noul)) throw new Error('jev: bad risky answer')

  return {
    model: result.model,
    tier: { choice: tier.choice as Tier, probabilities: tier.probabilities, confidence: confidenceField(tier.confidence) },
    effort: { probabilities: effort.probabilities, confidence: confidenceField(effort.confidence) },
    risky: risky.noul,
  }
}

export const jev: Classifier = {
  id: 'jev',
  async classify(situation, env, gateway) {
    const result = await env.AI.run('typesafe/jev', { state: situation, questions: QUESTIONS }, { gateway })
    const parsed = parseAnswers(result)
    return {
      classifier: `typesafe/jev@${parsed.model}`,
      tier: {
        value: parsed.tier.choice,
        confidence: parsed.tier.confidence ?? confidenceOf(parsed.tier.probabilities, TIERS.length),
      },
      effort: {
        level: argmaxHigh(parsed.effort.probabilities) as EffortLevel,
        confidence: parsed.effort.confidence ?? confidenceOf(parsed.effort.probabilities, QUESTIONS.effort.criteria.length),
      },
      risky: { p: parsed.risky },
    }
  },
}
