/**
 * model-router — the models it knows.
 *
 * The one place a model is described: its short alias, the full id sent for
 * that alias, the tier it usually belongs to, and whether it takes a
 * reasoning effort. Which model each tier sends is a setting (/config); this
 * list is only what those settings can name by alias.
 */
import type { Tier, Tiers } from './policy.ts'

export type Model = {
  /** Short name used in settings; also the word looked for in a full model id. */
  alias: string
  /** The full id sent for the alias; absent when the family has no id yet. */
  id?: string
  tier: Tier
  effort: boolean
}

export const MODELS: readonly Model[] = [
  { alias: 'haiku', id: 'claude-haiku-4-5-20251001', tier: 'fast', effort: false },
  { alias: 'sonnet', id: 'claude-sonnet-5', tier: 'balanced', effort: true },
  { alias: 'opus', id: 'claude-opus-5-5', tier: 'deep', effort: true },
  { alias: 'fable', id: 'claude-fable-5-1', tier: 'deep', effort: true },
  { alias: 'mythos', tier: 'deep', effort: true },
]

/** What each tier sends when its setting is left alone; plugin.json repeats these. */
export const DEFAULT_TIERS: Readonly<Tiers> = { fast: 'haiku', balanced: 'sonnet', deep: 'opus' }
