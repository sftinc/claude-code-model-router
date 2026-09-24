/**
 * model-router — the hooks.
 *
 * prompt.submit classifies the main-loop prompt and leaves the answer for the
 * next turn; turn.step applies it to the turn's first request and holds it for
 * the rest of the turn; agent.spawn classifies and routes a subagent on the
 * spot. Every failure leaves the request as it was.
 */
import type { AgentSpawnResult, Args, EngineInterface, Register } from 'claude-code'

import { buildRecent, builtinDecision, endpoint, readVerdict, requestHeaders, selectProvider } from './client.ts'
import type { RecentMessage, Situation } from './client.ts'
import { DEFAULT_TIERS } from './models.ts'
import {
  TIER_ORDER,
  changeBasis,
  describeDecision,
  describeMove,
  describeSetup,
  describeStatus,
  modelAlias,
  pendingDecisions,
  requestModelId,
  route,
  supportsEffort,
} from './policy.ts'
import type { Decision, Effort, PolicyConfig, Provider, Routing } from './policy.ts'

const TAG = '[model-router] '

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
  pending: ReturnType<typeof pendingDecisions<Classified>>
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
    pending: pendingDecisions<Classified>(),
    turn: null,
  }
}

// ---------------------------------------------------------------------------
// Logging. The transcript gets one short line per routed turn or subagent,
// and the warm-up's result (`tell`), so the router is visibly running without
// cluttering the chat; the details behind them, such as whole api replies, go
// to the debug log alone (`note`). logDecisions gates both. A line carrying a
// failure (`warn`) is always written, so a router that couldn't do its job
// says so.

function tell($: Engine, rt: Runtime, text: string): void {
  if (rt.opts.logDecisions) $.ui.log(TAG + text)
}

function note($: Engine, rt: Runtime, text: string): void {
  if (rt.opts.logDecisions) $.ui.log(TAG + text, { to: 'debug' })
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
// Classification. Never throws; any trouble means no decision, and says why.

/** A classification's outcome: the decision, or the short reason there is none. */
type Classified = { decision: Decision | null; failure: string | null }

const failed = (failure: string): Classified => ({ decision: null, failure })

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

type Race<T> = { settled: true; value: T } | { settled: false }

/** Whichever comes first: the answer or the timer. An answer after the timer is never seen. */
function beforeTimer<T>(answer: Promise<T>, timer: Promise<void>): Promise<Race<T>> {
  return Promise.race([
    answer.then((value): Race<T> => ({ settled: true, value })),
    timer.then((): Race<T> => ({ settled: false })),
  ])
}

async function askApi($: Engine, rt: Runtime, situation: Situation, who: string): Promise<Classified> {
  const { timeoutMs, apiSecret } = rt.opts
  const reply = $.http.fetch(rt.url, {
    method: 'POST',
    headers: requestHeaders(apiSecret),
    body: JSON.stringify(situation),
  })
  const outcome = await beforeTimer(reply, $.clock.sleep(timeoutMs))
  if (!outcome.settled) return failed(`no reply from the api within ${timeoutMs}ms`)
  const { ok, status, text } = outcome.value
  note($, rt, `api reply for ${who}: HTTP ${status} ${text}`)
  if (!ok) return failed(`api returned HTTP ${status}`)
  const decision = readVerdict(text)
  return decision ? { decision, failure: null } : failed('api reply was a malformed verdict')
}

async function askBuiltin($: Engine, rt: Runtime, prompt: string, who: string): Promise<Classified> {
  const { timeoutMs } = rt.opts
  const label = $.model.classify(prompt, [...TIER_ORDER])
  const outcome = await beforeTimer(label, $.clock.sleep(timeoutMs))
  if (!outcome.settled) return failed(`no reply from the built-in classifier within ${timeoutMs}ms`)
  note($, rt, `builtin label for ${who}: ${String(outcome.value)}`)
  return { decision: builtinDecision(outcome.value), failure: null }
}

async function classify($: Engine, rt: Runtime, situation: Situation, upOnly: boolean, who: string): Promise<Classified> {
  try {
    const got =
      rt.backend === 'api' ? await askApi($, rt, situation, who) : await askBuiltin($, rt, situation.prompt, who)
    return got.decision ? { decision: { ...got.decision, upOnly }, failure: null } : got
  } catch (error) {
    note($, rt, `classifier threw for ${who}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    return failed(`classifier threw: ${errorText(error)}`)
  }
}

/** The throwaway situation a warm-up sends. */
const WARM_UP: Situation = { source: 'main', prompt: 'warm-up' }

/**
 * Sends one throwaway classification in the background, so a classifier that
 * has gone cold is warm again by the first prompt. The timer detaches it from
 * the session.start dispatch; only how it went is reported.
 */
function warmUp($: Engine, rt: Runtime): void {
  const { apiSecret } = rt.opts
  $.clock.after(0, async () => {
    const started = await $.clock.now()
    try {
      const reply = await $.http.fetch(rt.url, {
        method: 'POST',
        headers: requestHeaders(apiSecret),
        body: JSON.stringify(WARM_UP),
      })
      const elapsed = (await $.clock.now()) - started
      note($, rt, `api reply for warm-up: HTTP ${reply.status} ${reply.text}`)
      if (reply.ok) tell($, rt, `classifier warmed up in ${elapsed}ms`)
      else warn($, `warm-up failed (api returned HTTP ${reply.status})`)
    } catch (error) {
      warn($, `warm-up failed (${errorText(error)})`)
    }
  })
}

/** Classifies, writes the verdict to the debug log, and returns the outcome. */
async function classifyAndReport(
  $: Engine,
  rt: Runtime,
  situation: Situation,
  upOnly: boolean,
  who: string,
): Promise<Classified> {
  const started = await $.clock.now()
  const got = await classify($, rt, situation, upOnly, who)
  const elapsed = (await $.clock.now()) - started
  const via = rt.backend === 'api' ? 'api' : 'builtin'
  note($, rt, `verdict via ${via} for ${who}: ${describeDecision(got.decision, elapsed)}`)
  return got
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
  rt.pending.put(await classifyAndReport($, rt, situation, upOnly, 'main loop'))
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

/** The line's body: model and effort, each with an arrow when it changes. */
function describeTurn(e: StepEvent, shaped: Shaped, decision: Decision | null, policy: PolicyConfig): string {
  const model = shaped.change?.model
  const parts = [
    describeMove(
      'model',
      modelAlias(e.model),
      model === undefined ? null : modelAlias(model),
      changeBasis(decision, decision?.confidence ?? null, policy),
    ),
  ]
  const effort = shaped.change?.effort
  if (shaped.stripped) parts.push('effort (dropped)')
  else if (effort !== undefined) {
    const basis = changeBasis(decision, decision?.effortConfidence ?? null, policy)
    parts.push(describeMove('effort', String(e.effort ?? 'unset'), effort, basis))
  } else if (e.effort !== undefined) parts.push(describeMove('effort', String(e.effort)))
  return parts.join(', ')
}

async function routeTurn($: Engine, rt: Runtime, e: StepEvent): Promise<Change | null> {
  const { decision, failure } = rt.pending.take() ?? { decision: null, failure: null }
  const routing = route(decision, { model: e.model, effort: e.effort }, rt.policy)
  const shaped = shapeChange(routing, e, rt.opts)

  if (shaped.change !== null || rt.mainCanChange) {
    const line = `main loop: ${describeTurn(e, shaped, decision, rt.policy)}`
    if (failure) warn($, `${line}, ${failure}`)
    else tell($, rt, line)
  }
  if (rt.mainCanChange) {
    const unapplied =
      routing.model !== null && !rt.opts.routeMainModel
        ? ` (${routing.model} not applied: main-model switching is disabled)`
        : ''
    note($, rt, `main loop: ${routing.reason}${unapplied}`)
  }
  // Shown only while the current turn is changed, so a turn sent as is clears it.
  if (rt.opts.logDecisions && rt.mainCanChange) {
    $.ui.status(shaped.change ? describeStatus(decision, shaped.change) : undefined)
  }
  return shaped.change
}

// ---------------------------------------------------------------------------
// agent.spawn

/** Where the router sends a subagent: the model to set (null: leave it), and what to report. */
type SpawnRouting = { model: string | null; moved: string | null; failure: string | null }

async function routeSpawn($: Engine, rt: Runtime, e: SpawnEvent): Promise<SpawnRouting> {
  const who = `subagent ${e.subagentType}`
  const situation: Situation = { source: 'subagent', prompt: e.prompt }
  if (typeof e.description === 'string') situation.description = e.description
  if (typeof e.subagentType === 'string') situation.agentType = e.subagentType
  const { decision, failure } = await classifyAndReport($, rt, situation, false, who)

  const pinned = rt.opts.respectAgentModels && e.model !== undefined
  const current = e.model ?? e.parentModel
  const routing = route(decision, { model: current, pinned }, rt.policy)
  note($, rt, `${who}: ${routing.reason}`)
  if (routing.model === null) return { model: null, moved: null, failure }
  const basis = changeBasis(decision, decision?.confidence ?? null, rt.policy)
  return { model: routing.model, moved: describeMove('model', modelAlias(current), modelAlias(routing.model), basis), failure }
}

/**
 * Reports what the subagent runs on. An unchanged one shows the model the
 * engine resolved, since its definition may name one the router can't see.
 */
function reportSpawn($: Engine, rt: Runtime, e: SpawnEvent, sent: SpawnRouting, started: AgentSpawnResult): void {
  const ranOn = started.deny === undefined ? started.model : undefined
  const parts: string[] = []
  if (sent.moved !== null) parts.push(sent.moved)
  else if (ranOn !== undefined) parts.push(describeMove('model', modelAlias(ranOn)))
  if (sent.failure !== null) parts.push(sent.failure)
  if (parts.length === 0) return
  const line = `subagent ${e.subagentType}: ${parts.join(', ')}`
  if (sent.failure !== null) warn($, line)
  else tell($, rt, line)
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
    const sent = await routeSpawn($, rt, e)
    const started = await next(sent.model === null ? e : { ...e, model: sent.model })
    reportSpawn($, rt, e, sent, started)
    return started
  })
}
