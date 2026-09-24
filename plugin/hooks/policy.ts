/**
 * model-router — the decision rules.
 *
 * Nothing in this file talks to the engine. Given a classifier's Decision and
 * what a request currently carries, it works out the model and effort to send,
 * and it formats the short lines the hooks write to the log and status bar.
 */
import { MODELS } from './models.ts'
import type { Model } from './models.ts'

export type Provider = 'api'

export type Tier = 'fast' | 'balanced' | 'deep'

/** Tiers from cheapest to most capable; a tier's index is its position. */
export const TIER_ORDER: readonly Tier[] = ['fast', 'balanced', 'deep']

/** The model alias or id configured for each tier. */
export type Tiers = { fast: string; balanced: string; deep: string }

/** The reasoning-effort ladder, lowest first. `max` sits above it but is never chosen here. */
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'] as const

export type Effort = (typeof EFFORT_ORDER)[number]

export type Decision = {
  tier: Tier
  confidence: number | null
  risky: number | null
  /** Integer effort level 0..3, or null when the classifier gave none. */
  effort: number | null
  effortConfidence: number | null
  /** The model that answered; null for the engine's built-in classifier. */
  classifier: string | null
  /** When true, this decision may only raise the model or effort, never lower them. */
  upOnly: boolean
}

export type PolicyConfig = {
  tiers: Tiers
  minUpgradeConfidence: number
  minDowngradeConfidence: number
  riskyThreshold: number
}

/** What to do with a request; null in either field means "leave it as it is". */
export type Routing = { model: string | null; effort: Effort | null; reason: string }

export type Current = { model: string; effort?: string | number; pinned?: boolean }

// ---------------------------------------------------------------------------
// Ladders and names

const MAX_EFFORT_RANK = 4

/** An effort level as a ladder name; fractions are dropped and the result is clamped to the ladder. */
export function effortName(level: number): Effort {
  const whole = Number.isNaN(level) ? 0 : Math.trunc(level)
  const index = Math.min(EFFORT_ORDER.length - 1, Math.max(0, whole))
  return EFFORT_ORDER[index] as Effort
}

/** Where an effort sits on the ladder: 0..3 for the named rungs, 4 for `max`, null for anything else. */
export function effortRank(effort: string | number | undefined): number | null {
  if (typeof effort !== 'string') return null
  if (effort === 'max') return MAX_EFFORT_RANK
  const index = (EFFORT_ORDER as readonly string[]).indexOf(effort)
  return index === -1 ? null : index
}

/** The listed model whose alias appears in a model id or alias, if any. */
function knownModel(model: string): Model | undefined {
  const id = model.toLowerCase()
  return MODELS.find((known) => id.includes(known.alias))
}

/**
 * A model's tier position. Configured tier values win (checked cheapest
 * first); failing that, the listed model's usual tier; otherwise unknown.
 */
export function rankOf(model: string, tiers: Tiers): number | null {
  const id = model.toLowerCase()
  for (const [position, tier] of TIER_ORDER.entries()) {
    const configured = tiers[tier].trim().toLowerCase()
    if (configured !== '' && id.includes(configured)) return position
  }
  const known = knownModel(model)
  return known ? TIER_ORDER.indexOf(known.tier) : null
}

/** The full model id for a short alias; anything that isn't an alias comes back untouched. */
export function requestModelId(model: string): string {
  const alias = model.trim().toLowerCase()
  return MODELS.find((known) => known.alias === alias)?.id ?? model
}

/** Whether a model takes a reasoning effort; one that isn't listed is assumed to. */
export function supportsEffort(model: string): boolean {
  return knownModel(model)?.effort ?? true
}

// ---------------------------------------------------------------------------
// Routing

/**
 * Whether a move from `from` to `to` clears the confidence bar. Only a move
 * down from a known position is a downgrade; anything else is an upgrade.
 * With no confidence, upgrades go through and downgrades don't.
 */
function clearsBar(from: number | null, to: number, confidence: number | null, config: PolicyConfig): boolean {
  if (from === to) return false
  const downgrade = from !== null && to < from
  if (confidence === null) return !downgrade
  return confidence >= (downgrade ? config.minDowngradeConfidence : config.minUpgradeConfidence)
}

const num = (value: number | null): string => (value === null ? '?' : value.toFixed(2))

/** Route one request: which model and effort the decision asks for, given what it carries now. */
export function route(decision: Decision | null, current: Current, config: PolicyConfig): Routing {
  if (!decision) return { model: null, effort: null, reason: 'no decision, request left as is' }

  const forced = decision.risky !== null && decision.risky > config.riskyThreshold
  const tier: Tier = forced ? 'deep' : decision.tier
  const level = forced ? Math.max(decision.effort ?? 0, 2) : decision.effort

  // Model.
  const wantedModel = config.tiers[tier]
  let model: string | null = null
  let heldByPin = false
  if (wantedModel !== '' && wantedModel !== current.model) {
    const from = rankOf(current.model, config.tiers)
    const to = TIER_ORDER.indexOf(tier)
    const wouldLower = from === null || to < from
    if (forced) {
      if (from === null || from < to) model = wantedModel
    } else if (current.pinned) {
      heldByPin = true
    } else if (decision.upOnly && wouldLower) {
      // an up-only decision can't move to a lower or unknown place
    } else if (clearsBar(from, to, decision.confidence, config)) {
      model = wantedModel
    }
  }

  // Effort: only for requests that carry a named effort.
  let effort: Effort | null = null
  if (level !== null && typeof current.effort === 'string') {
    const from = effortRank(current.effort)
    let to = EFFORT_ORDER.indexOf(effortName(level))
    if (forced && from !== null) to = Math.max(to, from)
    const lowering = from === null || to < from
    const blockedByUpOnly = decision.upOnly && !forced && lowering
    if (to !== from && !blockedByUpOnly && (forced || clearsBar(from, to, decision.effortConfidence, config))) {
      effort = EFFORT_ORDER[to] ?? null
    }
  }

  if (model !== null || effort !== null) {
    const why = forced
      ? `risk ${num(decision.risky)} is over the threshold, so deep is forced`
      : `chosen by tier ${tier}, confidence ${num(decision.confidence)}`
    return { model, effort, reason: why }
  }

  const flags = [
    decision.confidence === null ? 'confidence unreported' : `confidence ${num(decision.confidence)}`,
    decision.upOnly ? 'raise-only' : null,
    forced ? 'risk-forced' : null,
  ]
    .filter((flag): flag is string => flag !== null)
    .join('; ')

  let reason: string
  if (heldByPin) {
    reason = `agent chose ${current.model}, left in place; router preferred ${wantedModel} (${tier}; ${flags})`
  } else {
    const target = wantedModel === '' ? 'no model set' : wantedModel
    const effortWanted = level === null ? '' : `, effort ${effortName(level)}`
    const effortNow = typeof current.effort === 'string' ? ` with effort ${current.effort}` : ''
    reason = `no switch: router leaned ${tier} (${target}${effortWanted}; ${flags}), request stays on ${current.model}${effortNow}`
  }
  return { model: null, effort: null, reason }
}

// ---------------------------------------------------------------------------
// Hand-off between prompt.submit and turn.step

/**
 * The prompts submitted since the last turn began, oldest first. A turn only
 * gets a decision when exactly one prompt preceded it; with several, there's
 * no telling which one it answers. A null entry is a prompt whose
 * classification failed, and it still counts as a prompt.
 */
export function pendingDecisions(): { put(d: Decision | null): void; take(): Decision | null } {
  let since: (Decision | null)[] = []
  return {
    put(d) {
      // Past two entries the answer is "nothing" either way; don't grow further.
      if (since.length < 2) since.push(d)
    },
    take() {
      const only = since.length === 1 ? (since[0] ?? null) : null
      since = []
      return only
    },
  }
}

// ---------------------------------------------------------------------------
// Log text

export type Switches = { subagentModel: boolean; mainEffort: boolean; mainModel: boolean }

const SWITCH_NAMES: readonly (readonly [keyof Switches, string])[] = [
  ['subagentModel', 'subagent model'],
  ['mainEffort', 'main effort'],
  ['mainModel', 'main model'],
]

/** Where classifications come from and which parts of a request the router may touch. */
export function describeSetup(
  provider: Provider | null,
  url: string,
  switches: Switches,
  pickedBuiltin = false,
): string {
  let source = `api ${url}`
  if (provider !== 'api') source = `engine built-in (${pickedBuiltin ? 'picked in options' : 'no API configured'})`
  const routes = SWITCH_NAMES.filter(([key]) => switches[key]).map(([, name]) => name)
  return `classifier = ${source}; routes: ${routes.length === 0 ? 'none (every switch is off)' : routes.join(' + ')}`
}

/** A classifier answer on one line, e.g. `balanced@0.82, effort 2=high@0.61, risk 0.04 (jev, 41ms)`. */
export function describeDecision(decision: Decision | null, ms: number | null): string {
  const time = ms === null ? null : `${Math.round(ms)}ms`
  if (!decision) return time === null ? 'nothing came back' : `nothing came back after ${time}`

  let line = `${decision.tier}@${num(decision.confidence)}`
  if (decision.effort !== null) {
    line += `, effort ${decision.effort}=${effortName(decision.effort)}@${num(decision.effortConfidence)}`
  }
  if (decision.risky !== null) line += `, risk ${num(decision.risky)}`
  if (decision.upOnly) line += ', raise-only'
  const trailer = [decision.classifier, time].filter((bit): bit is string => bit !== null && bit !== '')
  return trailer.length === 0 ? line : `${line} (${trailer.join(', ')})`
}

/**
 * The status-bar text for a main-loop turn the router changed. A change can
 * come with no verdict: an effort is dropped when the model takes none.
 */
export function describeStatus(decision: Decision | null, change: { model?: string; effort?: Effort }): string {
  const verdict = decision ? `router ${decision.tier}@${num(decision.confidence)}` : 'router'
  const model = change.model !== undefined ? ` ${change.model}` : ''
  const effort = 'effort' in change ? ` ${change.effort ?? 'no effort'}` : ''
  return `${verdict} ⇒${model}${effort}`
}
