/**
 * v1: judge the work, not how it sounds.
 *
 * Aimed at three misses in the 2026-09-27 run: stakes leaking into tier and
 * effort (risky already asks about harm), short questions that need digging
 * read as trivial, and short approvals judged by their words instead of the
 * work they set in motion. risky is unchanged.
 */
import { QUESTIONS as CURRENT } from './current.ts'

const CONTEXT =
  'The model that answers `prompt` carries out the whole turn itself, reading code, running commands and editing files as needed. ' +
  'If `prompt` is a short reply (an approval, a pick like "2", "yes", "go ahead"), judge the work it sets in motion, read from `recent`. ' +
  'A question can take as much work as a change: judge what finding the answer takes, not how short the question is. ' +
  'Judge how hard the work is to do right, not how serious or risky its subject sounds.'

export const QUESTIONS = {
  ...CURRENT,
  tier: {
    type: 'choice',
    instructions: `Which rung best matches the judgment the work behind \`prompt\` demands? ${CONTEXT} Read it alongside \`recent\` if that is given, and, for a subagent, alongside its \`description\` and \`agentType\`.`,
    criteria: {
      fast: 'Following a clear instruction or giving an answer already in view: running known commands in a known order, acknowledging, repeating or restating something, or a small edit whose place and content are plain.',
      balanced:
        'Ordinary engineering with a known way forward: reading code to answer a question, a feature or fix within existing patterns, or a change across a few files.',
      deep: 'The right path is not yet known: designing or choosing an approach, hunting down a cause, reshaping how parts fit together, or a plan that later work will build on.',
    },
  },
  effort: {
    type: 'score',
    instructions: `How much working out does the work behind \`prompt\` take? ${CONTEXT} Read it alongside \`recent\` if that is given.`,
    criteria: [
      'The answer or action is already clear; carrying it out needs no working out.',
      'A routine change or lookup with a clear approach.',
      'Several interacting parts to hold together, or a cause that is not yet clear.',
      'A hard design decision or a subtle bug, where careful reasoning is what gets it right.',
    ],
  },
} as const
