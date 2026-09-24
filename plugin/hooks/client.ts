/**
 * model-router — the classifier's contract, on the mod's side.
 *
 * Pure functions only; the engine is never touched here. It picks the backend,
 * builds the situation's `recent` from session messages, and reads a verdict
 * into a Decision. The wire format is defined in worker/src/types.ts;
 * nothing here knows which model answers.
 */
import { TIER_ORDER } from './policy.ts'
import type { Decision, Provider, Tier } from './policy.ts'

export type RecentMessage = { role: 'user' | 'assistant'; text: string }

/** POST /v1/classify request body. */
export type Situation = {
  source: 'main' | 'subagent'
  prompt: string
  recent?: RecentMessage[]
  description?: string
  agentType?: string
}

/** The fields of a `$.session.messages()` entry that buildRecent reads. */
export type SessionEntry = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool_use_id: string; tool: string; input?: unknown }[]
  toolResults?: readonly { tool_use_id: string; text: string; isError: boolean }[]
}

type ToolResult = NonNullable<SessionEntry['toolResults']>[number]

/** `api` when both the URL and the secret are set and the built-in classifier wasn't chosen. */
export function selectProvider(forced: string, url: string, secret: string): Provider | null {
  if (forced === 'builtin') return null
  return url && secret ? 'api' : null
}

/** The classify endpoint under a base URL, whatever its trailing slashes or a pasted `/v1/classify`. */
export function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1\/classify$/, '')
  return `${base}/v1/classify`
}

export function requestHeaders(secret: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${secret}` }
}

/** A tool result as one short line: its first non-blank line, marked when it failed. */
function outcomeOf(result: ToolResult | undefined): string {
  if (!result) return 'no result'
  const first = result.text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
  const line = first.length > 120 ? `${first.slice(0, 117)}...` : first
  if (result.isError) return `error: ${line}`
  return line || 'ok'
}

function toRecent(entry: SessionEntry, results: ReadonlyMap<string, ToolResult>): RecentMessage {
  const lines = entry.text.trim() ? [entry.text.trim()] : []
  for (const use of entry.toolUses) lines.push(`[${use.tool}] ${outcomeOf(results.get(use.tool_use_id))}`)
  return { role: entry.role, text: lines.join('\n') }
}

/**
 * The last `n` messages before the prompt, tool calls reduced to their name
 * and a one-line outcome, within `chars`: the oldest go first, and a lone
 * message still over keeps its end. Undefined when `n` is 0 (prompt only).
 */
export function buildRecent(
  messages: readonly SessionEntry[],
  prompt: string,
  n: number,
  chars: number,
): RecentMessage[] | undefined {
  if (n <= 0) return undefined

  // Results can sit on a later message than the call they answer.
  const results = new Map<string, ToolResult>()
  for (const message of messages) for (const result of message.toolResults ?? []) results.set(result.tool_use_id, result)

  let list = [...messages]
  const last = list[list.length - 1]
  if (last && last.role === 'user' && last.text.trim() === prompt.trim()) list = list.slice(0, -1)

  const recent = list
    .map((entry) => toRecent(entry, results))
    .filter((message) => message.text !== '')
    .slice(-n)

  let total = recent.reduce((sum, message) => sum + message.text.length, 0)
  while (recent.length > 1 && total > chars) total -= recent.shift()?.text.length ?? 0
  const only = recent[0]
  if (recent.length === 1 && only && total > chars) recent[0] = { ...only, text: only.text.slice(-chars) }
  return recent
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUnit = (value: unknown): value is number => typeof value === 'number' && value >= 0 && value <= 1

const isConfidence = (value: unknown): value is number | null => value === null || isUnit(value)

const isTier = (value: unknown): value is Tier => TIER_ORDER.includes(value as Tier)

/** A verdict from /v1/classify as a Decision, or null for anything incomplete or out of range. */
export function readVerdict(text: string): Decision | null {
  let verdict: unknown
  try {
    verdict = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(verdict) || typeof verdict.classifier !== 'string' || verdict.classifier === '') return null
  const { tier, effort, risky } = verdict
  if (!isRecord(tier) || !isTier(tier.value) || !isConfidence(tier.confidence)) return null
  if (
    !isRecord(effort) ||
    typeof effort.level !== 'number' ||
    !Number.isInteger(effort.level) ||
    effort.level < 0 ||
    effort.level > 3 ||
    !isConfidence(effort.confidence)
  ) {
    return null
  }
  if (!isRecord(risky) || !isUnit(risky.p)) return null

  return {
    tier: tier.value,
    confidence: tier.confidence,
    effort: effort.level,
    effortConfidence: effort.confidence,
    risky: risky.p,
    classifier: verdict.classifier,
    upOnly: false,
  }
}

/** The built-in classifier's label as a Decision: a tier, no confidence, no effort or risk. */
export function builtinDecision(label: string | undefined): Decision | null {
  if (!isTier(label)) return null
  return { tier: label, confidence: null, risky: null, effort: null, effortConfidence: null, classifier: null, upOnly: false }
}
