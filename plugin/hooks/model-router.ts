/**
 * model-router — the hooks.
 *
 * prompt.submit classifies the main-loop prompt and leaves the answer for the
 * next turn; turn.step applies it to the turn's first request and holds it for
 * the rest of the turn; agent.spawn classifies and routes a subagent on the
 * spot. Every failure leaves the request as it was.
 */
import type { Args, EngineInterface, Register } from 'claude-code'

import { buildRecent, builtinDecision, endpoint, readVerdict, requestHeaders, selectProvider } from './client.ts'
import type { RecentMessage, Situation } from './client.ts'
import { DEFAULT_TIERS } from './models.ts'
import {
  TIER_ORDER,
  describeDecision,
  describeSetup,
  describeStatus,
  pendingDecisions,
  requestModelId,
  route,
  supportsEffort,
} from './policy.ts'
import type { Decision, Effort, PolicyConfig, Provider, Routing } from './policy.ts'

const TAG = '[model-router] '
const AS_IS = 'sending the request as is'

/** The engine and the event payloads, as Claude Code declares them. */
type Engine = EngineInterface
type PromptEvent = Args<'prompt.submit'>
type StepEvent = Args<'turn.step'>
type SpawnEvent = Args<'agent.spawn'>

type Change = { model?: string; effort?: Effort }

// ---------------------------------------------------------------------------
// Options: one table of defaults. A supplied value is used only when it has
// the default's type, and a string must also be non-empty.

type Options = {
  provider: string
  apiUrl: string
  apiSecret: string
  fastModel: string
  balancedModel: string
  deepModel: string
  minUpgradeConfidence: number
  minDowngradeConfidence: number
  riskyThreshold: number
  contextMessages: number
  contextChars: number
  routeSubagentModel: boolean
  respectAgentModels: boolean
  routeMainEffort: boolean
  routeMainModel: boolean
  timeoutMs: number
  warmUp: boolean
  logDecisions: boolean
}

const OPTION_DEFAULTS: Readonly<Options> = {
  provider: 'auto',
  apiUrl: '',
  apiSecret: '',
  fastModel: DEFAULT_TIERS.fast,
  balancedModel: DEFAULT_TIERS.balanced,
  deepModel: DEFAULT_TIERS.deep,
  minUpgradeConfidence: 0.3,
  minDowngradeConfidence: 0.6,
  riskyThreshold: 0.7,
  contextMessages: 30,
  contextChars: 60000,
  routeSubagentModel: true,
  respectAgentModels: true,
  routeMainEffort: true,
  routeMainModel: false,
  timeoutMs: 2000,
  warmUp: true,
  logDecisions: true,
}

function readOptions(given: Record<string, unknown>): Options {
  const merged: Record<string, unknown> = { ...OPTION_DEFAULTS }
  for (const [key, fallback] of Object.entries(OPTION_DEFAULTS)) {
    const value = given[key]
    const usable = typeof value === typeof fallback && value !== ''
    if (usable) merged[key] = value
  }
  return merged as Options
}

// ---------------------------------------------------------------------------
// Per-registration state

type Runtime = {
  opts: Options
  policy: PolicyConfig
  backend: Provider | null
  url: string
  mainCanChange: boolean
  once: { setup: boolean; apiWarning: boolean; historyWarning: boolean }
  pending: ReturnType<typeof pendingDecisions>
  turn: { id: string; change: Change | null } | null
}

function createRuntime(opts: Options): Runtime {
  const backend = selectProvider(opts.provider, opts.apiUrl, opts.apiSecret)
  return {
    opts,
    policy: {
      tiers: { fast: opts.fastModel, balanced: opts.balancedModel, deep: opts.deepModel },
      minUpgradeConfidence: opts.minUpgradeConfidence,
      minDowngradeConfidence: opts.minDowngradeConfidence,
      riskyThreshold: opts.riskyThreshold,
    },
    backend,
    url: backend === 'api' ? endpoint(opts.apiUrl) : '',
    // The built-in classifier gives no effort, so main effort needs the api.
    mainCanChange: opts.routeMainModel || (opts.routeMainEffort && backend === 'api'),
    once: { setup: false, apiWarning: false, historyWarning: false },
    pending: pendingDecisions(),
    turn: null,
  }
}

// ---------------------------------------------------------------------------
// Logging. `note` is informational and obeys logDecisions; `warn` is for
// warnings and failures and is always written.

function note($: Engine, rt: Runtime, text: string): void {
  if (rt.opts.logDecisions) $.ui.log(TAG + text)
}

function warn($: Engine, text: string): void {
  $.ui.log(TAG + text)
}

function setupOnce($: Engine, rt: Runtime): void {
  if (rt.once.setup) return
  rt.once.setup = true
  const switches = {
    subagentModel: rt.opts.routeSubagentModel,
    mainEffort: rt.opts.routeMainEffort && rt.backend === 'api',
    mainModel: rt.opts.routeMainModel,
  }
  note($, rt, describeSetup(rt.backend, rt.url, switches, rt.opts.provider === 'builtin'))
}

function apiWarningOnce($: Engine, rt: Runtime): void {
  if (rt.once.apiWarning) return
  rt.once.apiWarning = true
  if (rt.opts.provider === 'api' && rt.backend === null) {
    warn($, `provider "api" needs both apiUrl and apiSecret; falling back to the engine's own classifier`)
  }
}

// ---------------------------------------------------------------------------
// Classification. Never throws; any trouble means no decision.

type Race<T> = { settled: true; value: T } | { settled: false }

/** Whichever comes first: the answer or the timer. An answer after the timer is never seen. */
function beforeTimer<T>(answer: Promise<T>, timer: Promise<void>): Promise<Race<T>> {
  return Promise.race([
    answer.then((value): Race<T> => ({ settled: true, value })),
    timer.then((): Race<T> => ({ settled: false })),
  ])
}

async function askApi($: Engine, rt: Runtime, situation: Situation): Promise<Decision | null> {
  const { timeoutMs, apiSecret } = rt.opts
  const reply = $.http.fetch(rt.url, {
    method: 'POST',
    headers: requestHeaders(apiSecret),
    body: JSON.stringify(situation),
  })
  const outcome = await beforeTimer(reply, $.clock.sleep(timeoutMs))
  if (!outcome.settled) {
    warn($, `no reply from the api within ${timeoutMs}ms; ${AS_IS}`)
    return null
  }
  if (!outcome.value.ok) {
    warn($, `api returned HTTP ${outcome.value.status}; ${AS_IS}`)
    return null
  }
  const decision = readVerdict(outcome.value.text)
  if (!decision) warn($, `api reply was a malformed verdict; ${AS_IS}`)
  return decision
}

async function askBuiltin($: Engine, rt: Runtime, prompt: string): Promise<Decision | null> {
  const { timeoutMs } = rt.opts
  const label = $.model.classify(prompt, [...TIER_ORDER])
  const outcome = await beforeTimer(label, $.clock.sleep(timeoutMs))
  if (!outcome.settled) {
    warn($, `no reply from the built-in classifier within ${timeoutMs}ms; ${AS_IS}`)
    return null
  }
  return builtinDecision(outcome.value)
}

async function classify($: Engine, rt: Runtime, situation: Situation, upOnly: boolean): Promise<Decision | null> {
  try {
    const decision =
      rt.backend === 'api' ? await askApi($, rt, situation) : await askBuiltin($, rt, situation.prompt)
    return decision ? { ...decision, upOnly } : null
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    warn($, `classifier threw (${why}); ${AS_IS}`)
    return null
  }
}

/** The throwaway situation a warm-up sends. */
const WARM_UP: Situation = { source: 'main', prompt: 'warm-up' }

/**
 * Sends one throwaway classification in the background, so a classifier that
 * has gone cold is warm again by the first prompt. The timer detaches it from
 * the session.start dispatch; its answer, or failure, is ignored.
 */
function warmUp($: Engine, rt: Runtime): void {
  const { apiSecret } = rt.opts
  $.clock.after(0, () => {
    $.http
      .fetch(rt.url, { method: 'POST', headers: requestHeaders(apiSecret), body: JSON.stringify(WARM_UP) })
      .catch(() => undefined)
  })
}

/** Classifies, writes the verdict line, and returns the decision. */
async function classifyAndReport(
  $: Engine,
  rt: Runtime,
  situation: Situation,
  upOnly: boolean,
  about: string,
): Promise<Decision | null> {
  const started = await $.clock.now()
  const decision = await classify($, rt, situation, upOnly)
  const elapsed = (await $.clock.now()) - started
  const via = rt.backend === 'api' ? 'api' : 'builtin'
  note($, rt, `verdict via ${via}${about}: ${describeDecision(decision, elapsed)}`)
  return decision
}

// ---------------------------------------------------------------------------
// prompt.submit

async function onPrompt($: Engine, rt: Runtime, e: PromptEvent): Promise<void> {
  setupOnce($, rt)
  if (!rt.mainCanChange) return
  apiWarningOnce($, rt)

  const prompt = typeof e.text === 'string' ? e.text : ''
  if (prompt.trim() === '') {
    rt.pending.put(null)
    return
  }

  let recent: RecentMessage[] | undefined
  let upOnly = false
  if (rt.opts.contextMessages > 0) {
    try {
      const messages = await $.session.messages()
      recent = buildRecent(messages, prompt, rt.opts.contextMessages, rt.opts.contextChars)
    } catch {
      upOnly = true
      if (!rt.once.historyWarning) {
        rt.once.historyWarning = true
        warn($, 'session history unavailable; prompts go to the classifier alone, raise-only')
      }
    }
  }

  const situation: Situation = recent ? { source: 'main', prompt, recent } : { source: 'main', prompt }
  rt.pending.put(await classifyAndReport($, rt, situation, upOnly, ''))
}

// ---------------------------------------------------------------------------
// turn.step

type Shaped = { change: Change | null; stripped: boolean; sendsTo: string }

/**
 * What a routing becomes for this request under the switches. The effort is
 * cleared outright (key present, value undefined) whenever the request carries
 * one but its destination model takes none, regardless of the switches.
 */
function shapeChange(routing: Routing, e: StepEvent, opts: Options): Shaped {
  const model = opts.routeMainModel && routing.model !== null ? requestModelId(routing.model) : undefined
  const sendsTo = model ?? e.model
  const stripped = e.effort !== undefined && !supportsEffort(sendsTo)

  const modelPart = model === undefined ? null : { model }
  let effortPart: Pick<Change, 'effort'> | null = null
  if (stripped) effortPart = { effort: undefined }
  else if (opts.routeMainEffort && routing.effort !== null) effortPart = { effort: routing.effort }

  const change = modelPart || effortPart ? { ...modelPart, ...effortPart } : null
  return { change, stripped, sendsTo }
}

function explainChange(e: StepEvent, shaped: Shaped, routing: Routing): string {
  const said: string[] = []
  if (shaped.change?.model !== undefined) said.push(`model ${e.model} → ${shaped.change.model}`)
  if (shaped.stripped) said.push(`effort dropped since ${shaped.sendsTo} takes none`)
  else if (shaped.change?.effort !== undefined) said.push(`effort ${e.effort ?? 'unset'} → ${shaped.change.effort}`)
  const routed = routing.model !== null || routing.effort !== null
  return `main loop: ${said.join(' and ')}${routed ? ` — ${routing.reason}` : ''}`
}

async function routeTurn($: Engine, rt: Runtime, e: StepEvent): Promise<Change | null> {
  const decision = rt.pending.take()
  const routing = route(decision, { model: e.model, effort: e.effort }, rt.policy)
  const shaped = shapeChange(routing, e, rt.opts)

  if (shaped.change !== null) {
    note($, rt, explainChange(e, shaped, routing))
  } else if (rt.mainCanChange) {
    const unapplied =
      routing.model !== null && !rt.opts.routeMainModel
        ? ` (${routing.model} not applied: main-model switching is disabled)`
        : ''
    note($, rt, `main loop as sent${unapplied} — ${routing.reason}`)
  }
  // Shown only while the current turn is changed, so a turn sent as is clears it.
  if (rt.opts.logDecisions && rt.mainCanChange) {
    $.ui.status(shaped.change ? describeStatus(decision, shaped.change) : undefined)
  }
  return shaped.change
}

// ---------------------------------------------------------------------------
// agent.spawn

async function onSpawn($: Engine, rt: Runtime, e: SpawnEvent): Promise<string | null> {
  const kind = e.subagentType ?? 'subagent'
  const situation: Situation = { source: 'subagent', prompt: e.prompt }
  if (typeof e.description === 'string') situation.description = e.description
  if (typeof e.subagentType === 'string') situation.agentType = e.subagentType
  const decision = await classifyAndReport($, rt, situation, false, ` for ${kind}`)

  const pinned = rt.opts.respectAgentModels && e.model !== undefined
  const routing = route(decision, { model: e.model ?? e.parentModel, pinned }, rt.policy)
  if (routing.model === null) note($, rt, `spawn of ${kind} left alone (${routing.reason})`)
  else note($, rt, `spawn of ${kind} goes to ${routing.model} (${routing.reason})`)
  return routing.model
}

// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const rt = createRuntime(readOptions((options ?? {}) as Record<string, unknown>))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Only with a person at the prompt: a -p run's first prompt arrives at once,
    // so a warm-up would only race it.
    if (e.isInteractive && rt.backend === 'api' && rt.opts.warmUp) warmUp($, rt)
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    await onPrompt($, rt, e)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)

    const sameTurn = e.index > 0 && rt.turn !== null && rt.turn.id === e.turnId
    const change = sameTurn && rt.turn ? rt.turn.change : await routeTurn($, rt, e)
    if (!sameTurn) rt.turn = { id: e.turnId, change }
    return yield* next(change ? { ...e, ...change } : e)
  })

  on('agent.spawn', async ($, e, next) => {
    setupOnce($, rt)
    if (!rt.opts.routeSubagentModel || e.fork) return next(e)
    apiWarningOnce($, rt)
    if (typeof e.prompt !== 'string' || e.prompt.trim() === '') return next(e)
    const model = await onSpawn($, rt, e)
    return next(model === null ? e : { ...e, model })
  })
}
