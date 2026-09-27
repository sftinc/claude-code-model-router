/**
 * v2a: today's tier ladder with v1's context, v1's effort, and a rule for
 * background notices. v1's tier ladder pulled balanced work into fast and
 * deep; notices (a finished task, an agent's report) read as deep because
 * the report inside them describes hard work that is already done.
 */
import { QUESTIONS as CURRENT } from './current.ts'
import { QUESTIONS as V1 } from './v1.ts'

export const NOTICES =
  'When `prompt` is a notice that background work finished (a <task-notification> or an agent\'s report), the work is already done: judge only what is left to do with the result.'

export const QUESTIONS = {
  ...V1,
  tier: { ...V1.tier, instructions: `${V1.tier.instructions} ${NOTICES}`, criteria: CURRENT.tier.criteria },
  effort: { ...V1.effort, instructions: `${V1.effort.instructions} ${NOTICES}` },
} as const
