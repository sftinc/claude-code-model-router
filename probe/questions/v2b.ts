/** v2b: v1 as it is, plus the rule for background notices from v2a. */
import { QUESTIONS as V1 } from './v1.ts'
import { NOTICES } from './v2a.ts'

export const QUESTIONS = {
  ...V1,
  tier: { ...V1.tier, instructions: `${V1.tier.instructions} ${NOTICES}` },
  effort: { ...V1.effort, instructions: `${V1.effort.instructions} ${NOTICES}` },
} as const
