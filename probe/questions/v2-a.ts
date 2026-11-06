// Round 3 draft: effort asks how much checking and independent work a turn needs, as Anthropic frames it.
import { QUESTIONS as CURRENT } from '../../worker/src/classifiers/jev-questions.ts'

const context = CURRENT.effort.instructions.slice(CURRENT.effort.instructions.indexOf('The model that answers'))

export const QUESTIONS = {
  ...CURRENT,
  effort: {
    type: 'score',
    instructions: `How much checking and independent work does the work behind \`prompt\` need? ${context}`,
    criteria: [
      'Quick, in-the-loop work: an answer, a lookup, a sketch or an easy edit, where the user sees the result straight away and steers.',
      'Regular engineering with a clear result that can be reviewed once, such as building a feature or carrying out a settled plan.',
      'The result has to be verified before it counts as done: edge cases, a bug in existing code, interacting parts, or a live change that needs checking afterwards.',
      'Long, hard work carried on alone, more than about 30 minutes without the user.',
    ],
  },
} as const
