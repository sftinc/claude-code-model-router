/**
 * The questions the Worker asks Jev. They sit apart from the adapter, with no
 * runtime imports, so probe/replay.ts can load them in plain Node and try
 * variants against logged situations.
 */
import type { Tier } from '../types'

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
