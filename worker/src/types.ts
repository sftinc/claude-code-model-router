/**
 * The mod ↔ Worker contract (spec: Wire format) and the Worker's environment.
 * Nothing here is specific to any classifier model.
 */

export type GatewayOptions = {
  id: string
  skipCache: boolean
  collectLog: boolean
  metadata: Record<string, string>
}

export type Env = {
  AI: {
    run(model: string, inputs: unknown, options: { gateway: GatewayOptions }): Promise<unknown>
    aiGatewayLogId?: string | null
  }
  ROUTER_SECRET?: string
  GATEWAY_ID: string
  COLLECT_LOG?: string
  CF_VERSION_METADATA: { id: string }
}

export type Situation = {
  source: 'main' | 'subagent'
  prompt: string
  recent?: { role: 'user' | 'assistant'; text: string }[]
  description?: string
  agentType?: string
}

export type Tier = 'fast' | 'balanced' | 'deep'

/** 0..3 → low, medium, high, xhigh on the mod's effort ladder. */
export type EffortLevel = 0 | 1 | 2 | 3

export type Verdict = {
  classifier: string
  tier: { value: Tier; confidence: number | null }
  effort: { level: EffortLevel; confidence: number | null }
  risky: { p: number }
}

export type Classifier = {
  id: string
  classify(situation: Situation, env: Env, gateway: GatewayOptions): Promise<Verdict>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string'

/** The body is a Situation, or the request is refused with 400. */
export function isSituation(value: unknown): value is Situation {
  if (!isRecord(value)) return false
  if (value.source !== 'main' && value.source !== 'subagent') return false
  if (typeof value.prompt !== 'string' || value.prompt.trim() === '') return false
  if (!isOptionalString(value.description) || !isOptionalString(value.agentType)) return false
  if (value.recent === undefined) return true
  return (
    Array.isArray(value.recent) &&
    value.recent.every(
      (message) =>
        isRecord(message) &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.text === 'string',
    )
  )
}
