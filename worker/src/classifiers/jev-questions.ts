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

/**
 * Situations, not degrees. The index is the level. Stakes stay out: `risky`
 * asks about harm, and a stakes clause here pushed routine work to xhigh.
 */
const EFFORT_CRITERIA = [
  'The answer or action is already clear; carrying it out needs no working out.',
  'A routine change or lookup with a clear approach.',
  'Several interacting parts to hold together, or a cause that is not yet clear.',
  'A hard design decision or a subtle bug, where careful reasoning is what gets it right.',
] as const

/**
 * How to read the work behind `prompt`, shared by tier and effort. Without it
 * Jev judged prompts by their words: routine requests that sound serious went
 * up, and short questions or approvals that start real work went down.
 */
const WORK =
  'The model that answers `prompt` carries out the whole turn itself, reading code, running commands and editing files as needed. ' +
  'If `prompt` is a short reply (an approval, a pick like "2", "yes", "go ahead"), judge the work it sets in motion, read from `recent`. ' +
  'A question can take as much work as a change: judge what finding the answer takes, not how short the question is. ' +
  'Judge how hard the work is to do right, not how serious or risky its subject sounds.'

/** A finished-work notice carries a report of hard work already done, which otherwise reads as deep. */
const NOTICES =
  "When `prompt` is a notice that background work finished (a <task-notification> or an agent's report), the work is already done: judge only what is left to do with the result."

/** Questions name situation fields by path. */
export const QUESTIONS = {
  tier: {
    type: 'choice',
    instructions: `Which rung best matches the judgment the work behind \`prompt\` demands? ${WORK} Read it alongside \`recent\` if that is given, and, for a subagent, alongside its \`description\` and \`agentType\`. ${NOTICES}`,
    criteria: TIER_LADDER,
  },
  effort: {
    type: 'score',
    instructions: `How much working out does the work behind \`prompt\` take? ${WORK} Read it alongside \`recent\` if that is given. ${NOTICES}`,
    criteria: EFFORT_CRITERIA,
  },
  risky: {
    type: 'noul',
    // Score the consequence of doing the work, never the topic the work concerns.
    instructions:
      'Once `prompt` has been carried out, taking `recent`, `description` and `agentType` into account where given, will the carrying out itself have left harm behind that nobody can reverse? Score the deed and its consequences, not its subject: a task on a sensitive topic whose performance harms nothing is a no.',
  },
} as const
