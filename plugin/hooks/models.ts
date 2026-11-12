/**
 * model-router — the models it knows.
 *
 * The one place a model is described: its short alias, the tier it usually
 * belongs to, and whether it takes a reasoning effort. Requests name the alias,
 * so the engine always picks the latest model of that family. Which model each
 * tier sends is a setting (/config); this list is only what those settings can
 * name by alias.
 */
import type { Tier, Tiers } from './policy.ts'

export type Model = {
  /** Short name used in settings; also the word looked for in a full model id. */
  alias: string
  tier: Tier
  effort: boolean
}

export const MODELS: readonly Model[] = [
  // Before `haiku`, since the first alias found in an id wins: a session can still name Haiku 4, whose API errors on effort.
  { alias: 'haiku-4', tier: 'fast', effort: false },
  { alias: 'haiku', tier: 'fast', effort: true },
  { alias: 'sonnet', tier: 'balanced', effort: true },
  { alias: 'opus', tier: 'deep', effort: true },
  { alias: 'mythos', tier: 'deep', effort: true },
]

/** What each tier sends when its setting is left alone; plugin.json repeats these. */
export const DEFAULT_TIERS: Readonly<Tiers> = { fast: 'haiku', balanced: 'sonnet', deep: 'opus' }
