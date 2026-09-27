/**
 * Sends each logged situation back through Jev with a set of questions and
 * saves the answers, so score.ts can score them against the same labels.
 *
 *   node probe/replay.ts probe/logs/<run> <questions>
 *
 * <questions> names probe/questions/<questions>.ts, which exports QUESTIONS.
 * Answers go to <run>/replays/<questions>.jsonl. Calls go straight to Workers
 * AI, not through the gateway, so replays never show up in what pull.sh reads.
 *
 * Needs ROUTER_GATEWAY_TOKEN with Workers AI Read and CLOUDFLARE_ACCOUNT_ID in worker/.env.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [run, name] = process.argv.slice(2)
if (!run || !name) throw new Error('usage: node probe/replay.ts probe/logs/<run> <questions>')

process.loadEnvFile(new URL('../worker/.env', import.meta.url))
const { QUESTIONS } = await import(`./questions/${name}.ts`)
const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/typesafe/jev`

const calls = readFileSync(join(run, 'requests.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

/** One answer, in the same `{ state, result }` shape the gateway logs, so score.ts reads both alike. */
async function ask(state: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.ROUTER_GATEWAY_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state, questions: QUESTIONS }),
  })
  const body = await res.json()
  if (!res.ok || !body.success) throw new Error(`Workers AI ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`)
  return body.result?.state ? body.result : { state: 'Completed', result: body.result }
}

// Eight at a time; a failed call is recorded and skipped, so one blip doesn't cost the run.
const answers = new Map<string, unknown>()
const queue = [...calls]
let failed = 0
async function drain() {
  for (let call = queue.shift(); call; call = queue.shift()) {
    try {
      answers.set(call.id, { id: call.id, response: await ask(call.request.state) })
    } catch (error) {
      failed++
      console.error(`${call.id.slice(0, 8)}: ${(error as Error).message}`)
      if (failed === 1 && answers.size === 0) throw error
    }
  }
}
await Promise.all(Array.from({ length: 8 }, drain))

mkdirSync(join(run, 'replays'), { recursive: true })
const out = join(run, 'replays', `${name}.jsonl`)
writeFileSync(out, calls.filter((call) => answers.has(call.id)).map((call) => JSON.stringify(answers.get(call.id))).join('\n') + '\n')
console.log(`${answers.size} answers in ${out}${failed ? `, ${failed} failed` : ''}`)
