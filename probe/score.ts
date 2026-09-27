/**
 * Scores Jev's answers against the labels for one probe run, then replays
 * candidate routing rules over the same calls to see what each would send.
 *
 *   node probe/score.ts probe/logs/<run> [replay]
 *
 * Reads requests.jsonl and labels/*.jsonl, and writes compared.jsonl: one row
 * per labeled call with Jev's answer and the label side by side. With a replay
 * name, Jev's answers come from replays/<replay>.jsonl instead of the logs,
 * and the rows go to compared-<replay>.jsonl.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { route } from '../plugin/hooks/policy.ts'
import type { Tier } from '../plugin/hooks/policy.ts'
import { argmaxHigh, confidenceOf } from '../worker/src/confidence.ts'

const TIERS: Tier[] = ['fast', 'balanced', 'deep']
const MODEL_OF: Record<Tier, string> = { fast: 'haiku', balanced: 'sonnet', deep: 'opus' }
const EFFORTS = ['low', 'medium', 'high', 'xhigh']

const [run, replay] = process.argv.slice(2)
if (!run) throw new Error('usage: node probe/score.ts probe/logs/<run> [replay]')

const jsonLines = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

const labels = new Map<string, { tier: Tier; effort: number; reason: string }>()
for (const file of readdirSync(join(run, 'labels'))) {
  for (const label of jsonLines(join(run, 'labels', file))) labels.set(label.id, label)
}

const replayed = new Map<string, any>()
if (replay) for (const answer of jsonLines(join(run, 'replays', `${replay}.jsonl`))) replayed.set(answer.id, answer.response)
const responseOf = (call: any) => (replay ? replayed.get(call.id) : call.response)

const rows = jsonLines(join(run, 'requests.jsonl'))
  .filter((call) => labels.has(call.id) && responseOf(call))
  .map((call) => {
    const answers = responseOf(call).result.answers
    const label = labels.get(call.id)!
    return {
      id: call.id as string,
      prompt: String(call.request.state.prompt).slice(0, 160),
      jevTier: answers.tier.choice as Tier,
      jevTierConfidence: answers.tier.confidence as number | null,
      jevTierP: answers.tier.probabilities as Record<Tier, number>,
      jevEffortP: answers.effort.probabilities as Record<string, number>,
      jevEffortConfidence: answers.effort.confidence as number | null,
      jevEffortScore: answers.effort.score as number,
      jevRisky: answers.risky.noul as number,
      labelTier: label.tier,
      labelEffort: label.effort,
      reason: label.reason,
    }
  })
writeFileSync(join(run, replay ? `compared-${replay}.jsonl` : 'compared.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

type Row = (typeof rows)[number]
type Pick = { model: string; effort: string }

// ---------------------------------------------------------------------------
// Jev against the labels

function matrix(title: string, keys: string[], label: (row: Row) => string, jev: (row: Row) => string) {
  console.log(`\n${title} (rows: label, columns: Jev)`)
  console.log(['', ...keys].join('\t'))
  for (const key of keys) {
    const counts = keys.map((column) => rows.filter((row) => label(row) === key && jev(row) === column).length)
    console.log([key, ...counts].join('\t'))
  }
}

console.log(`${rows.length} labeled calls, Jev's answers from ${replay ? `replay ${replay}` : 'the logs'}`)
matrix('Tier', TIERS, (row) => row.labelTier, (row) => row.jevTier)
matrix('Effort, most likely level', ['0', '1', '2', '3'], (row) => String(row.labelEffort), (row) => String(argmaxHigh(row.jevEffortP)))

// ---------------------------------------------------------------------------
// Routing rules: add a line to RULES to try another one

/** What the Worker sent before round 1: the most likely level. */
const likeliestEffort = (row: Row) => argmaxHigh(row.jevEffortP)

/** Jev's weighted effort score, rounded with a slight lean down. */
const scoreEffort = (row: Row) => Math.min(3, Math.max(0, Math.floor(row.jevEffortScore + 0.25)))

/** The real policy, fed the decision the Worker would build from this answer. */
function viaPolicy(effort: (row: Row) => number, bars: { up: number; down: number }) {
  const config = { tiers: MODEL_OF, minUpgradeConfidence: bars.up, minDowngradeConfidence: bars.down, riskyThreshold: 0.7 }
  return (row: Row, start: Pick): Pick => {
    const decision = {
      tier: row.jevTier,
      confidence: row.jevTierConfidence ?? confidenceOf(row.jevTierP, TIERS.length),
      risky: row.jevRisky,
      effort: effort(row),
      effortConfidence: row.jevEffortConfidence ?? confidenceOf(row.jevEffortP, EFFORTS.length),
      classifier: 'jev',
      upOnly: false,
    }
    const out = route(decision, start, config)
    return { model: out.model ?? start.model, effort: out.effort ?? start.effort }
  }
}

/**
 * Haiku only when P(fast) clears `fast`, Opus only when P(deep) clears `deep`, else Sonnet; effort always follows.
 * With 0.7 and 0.4 this is what the Worker's tierFrom and effortFrom send today.
 */
const byProbability = (fast: number, deep: number, effort: (row: Row) => number) => (row: Row): Pick => ({
  model: MODEL_OF[row.jevTierP.fast >= fast ? 'fast' : (row.jevTierP.deep ?? 0) >= deep ? 'deep' : 'balanced'],
  effort: EFFORTS[effort(row)]!,
})

const RULES: [string, (row: Row, start: Pick) => Pick][] = [
  ['before round 1: bars 0.3/0.6, likeliest effort', viaPolicy(likeliestEffort, { up: 0.3, down: 0.6 })],
  ['bars 0.3 up / 0.6 down, score effort', viaPolicy(scoreEffort, { up: 0.3, down: 0.6 })],
  ['follow Jev (no bars), score effort', viaPolicy(scoreEffort, { up: 0, down: 0 })],
  ['haiku P(fast)>=0.6, opus P(deep)>=0.4, score effort', byProbability(0.6, 0.4, scoreEffort)],
  ['live: haiku P(fast)>=0.7, opus P(deep)>=0.4, score', byProbability(0.7, 0.4, scoreEffort)],
]

/** A turn starts on the session's model and effort; the rule decides what it moves to. */
const STARTS: Pick[] = [
  { model: 'opus', effort: 'high' },
  { model: 'sonnet', effort: 'medium' },
]

const tally = () => ({ over: 0, right: 0, under: 0 })
const count = (t: ReturnType<typeof tally>, diff: number) => t[diff > 0 ? 'over' : diff < 0 ? 'under' : 'right']++
const show = (t: ReturnType<typeof tally>) => `${t.over}/${t.right}/${t.under}`
const rank = (model: string) => TIERS.findIndex((tier) => MODEL_OF[tier] === model)

for (const start of STARTS) {
  console.log(`\nEach turn starting on ${start.model}/${start.effort}`)
  console.log(`  ${'rule'.padEnd(52)} ${'tier o/r/u'.padEnd(12)} ${'haiku miss'.padEnd(11)} effort o/r/u (haiku turns left out)`)
  for (const [name, pick] of RULES) {
    const tier = tally()
    const effort = tally()
    let haikuMisses = 0
    for (const row of rows) {
      const got = pick(row, start)
      count(tier, rank(got.model) - TIERS.indexOf(row.labelTier))
      if (got.model === 'haiku') {
        if (row.labelTier !== 'fast') haikuMisses++
        continue
      }
      count(effort, EFFORTS.indexOf(got.effort) - row.labelEffort)
    }
    console.log(`  ${name.padEnd(52)} ${show(tier).padEnd(12)} ${String(haikuMisses).padEnd(11)} ${show(effort)}`)
  }
}
