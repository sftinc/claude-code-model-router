/**
 * The Jev adapter: the only file that knows Jev's answer shapes. The questions
 * are in jev-questions.ts.
 *
 * Per Cloudflare's model page, `env.AI.run('typesafe/jev', …)` returns the bare
 * `{ model, answers, usage }`, and a score's probabilities are keyed by level
 * index as a string ("0".."3"). Anything else throws, which the Worker turns
 * into a 502 and the mod into "request unchanged".
 */
import { confidenceOf } from '../confidence'
import type { Classifier, EffortLevel, Situation, Tier } from '../types'
import { QUESTIONS } from './jev-questions'

const TIERS: readonly Tier[] = ['fast', 'balanced', 'deep']

type Answer = { probabilities: Record<string, number>; confidence: number | null }

export type Parsed = {
  model: string
  tier: Answer & { choice: Tier }
  effort: Answer & { score: number }
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
    !Object.keys(effort.probabilities).every((key) => /^[0-3]$/.test(key)) ||
    typeof effort.score !== 'number' ||
    !(effort.score >= 0 && effort.score <= 3)
  ) {
    throw new Error('jev: bad effort answer')
  }
  if (!isRecord(risky) || !isUnit(risky.noul)) throw new Error('jev: bad risky answer')

  return {
    model: result.model,
    tier: { choice: tier.choice as Tier, probabilities: tier.probabilities, confidence: confidenceField(tier.confidence) },
    effort: { probabilities: effort.probabilities, confidence: confidenceField(effort.confidence), score: effort.score },
    risky: risky.noul,
  }
}

/**
 * The tier to send, read from Jev's probabilities rather than its pick. Fast
 * needs a clear lead, because fast work that isn't sends real work to the
 * smallest model; deep needs less, because Jev seldom gives it much weight at
 * all. A subagent's bar is higher: Jev sees only its brief, and a long,
 * detailed brief reads as deep work when most of it isn't. Anything in between
 * is balanced. Tuned in probe/RESULTS.md, rounds 1 and 2.
 */
export function tierFrom(probabilities: Record<string, number>, source: Situation['source']): Tier {
  if ((probabilities.fast ?? 0) >= 0.7) return 'fast'
  if ((probabilities.deep ?? 0) >= (source === 'subagent' ? 0.6 : 0.4)) return 'deep'
  return 'balanced'
}

/**
 * Jev's weighted effort score, rounded with a slight lean down. The likeliest
 * level turned close splits (say 38% xhigh, 36% medium) into xhigh.
 */
export function effortFrom(score: number): EffortLevel {
  return Math.min(3, Math.max(0, Math.floor(score + 0.25))) as EffortLevel
}

export const jev: Classifier = {
  id: 'jev',
  async classify(situation, env, gateway) {
    const result = await env.AI.run('typesafe/jev', { state: situation, questions: QUESTIONS }, { gateway })
    const parsed = parseAnswers(result)
    const tier = tierFrom(parsed.tier.probabilities, situation.source)
    return {
      classifier: `typesafe/jev@${parsed.model}`,
      // Confidence in the tier sent, which may not be the one Jev picked.
      tier: { value: tier, confidence: confidenceOf({ [tier]: parsed.tier.probabilities[tier] ?? 0 }, TIERS.length) },
      effort: {
        level: effortFrom(parsed.effort.score),
        confidence: parsed.effort.confidence ?? confidenceOf(parsed.effort.probabilities, QUESTIONS.effort.criteria.length),
      },
      risky: { p: parsed.risky },
    }
  },
}
