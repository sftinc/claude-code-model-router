/**
 * The Jev adapter: the only file that knows Jev's questions and answer shapes.
 *
 * Per Cloudflare's model page, `env.AI.run('typesafe/jev', …)` returns the bare
 * `{ model, answers, usage }`, and a score's probabilities are keyed by level
 * index as a string ("0".."3"). Anything else throws, which the Worker turns
 * into a 502 and the mod into "request unchanged".
 */
import { argmaxHigh, confidenceOf } from '../confidence'
import type { Classifier, EffortLevel, Tier } from '../types'

const TIERS: readonly Tier[] = ['fast', 'balanced', 'deep']

/**
 * A ladder of demand. Each rung says how much judgment the work calls
 * for and what an error would cost; no rung mentions a model.
 */
const TIER_LADDER: Record<Tier, string> = {
  fast: 'Hardly any judgment is called for. The right result is plain once the request is read, and a slip would show up at once and take moments to put right.',
  balanced:
    'Ordinary engineering judgment is called for inside settled bounds. The way forward is known, and a slip would most likely be caught by review or tests before it did harm.',
  deep: 'Sustained judgment is called for because the right path is not obvious, and a slip could be expensive, slow to come to light, or hard to trace back to its cause.',
}

/** Situations, not degrees. The index is the level. */
const EFFORT_CRITERIA = [
  'The answer or edit is obvious from context.',
  'A routine change with a clear approach.',
  'Several interacting parts, or an unclear cause.',
  'A design decision, subtle bug, or high-stakes change where mistakes are costly.',
] as const

/** Questions name situation fields by path. */
export const QUESTIONS = {
  tier: {
    type: 'choice',
    instructions:
      'Which rung best matches the judgment `prompt` demands and the cost of getting it wrong? Read it alongside `recent` if that is given, and, for a subagent, alongside its `description` and `agentType`.',
    criteria: TIER_LADDER,
  },
  effort: {
    type: 'score',
    instructions: 'Which of these situations best describes the work `prompt` asks for, reading it alongside `recent` if that is given?',
    criteria: EFFORT_CRITERIA,
  },
  risky: {
    type: 'noul',
    // Score the consequence of doing the work, never the topic the work concerns.
    instructions:
      'Once `prompt` has been carried out, taking `recent`, `description` and `agentType` into account where given, will the carrying out itself have left harm behind that nobody can reverse? Score the deed and its consequences, not its subject: a task on a sensitive topic whose performance harms nothing is a no.',
  },
} as const

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
        confidence: parsed.effort.confidence ?? confidenceOf(parsed.effort.probabilities, EFFORT_CRITERIA.length),
      },
      risky: { p: parsed.risky },
    }
  },
}
