/**
 * Classifier-neutral math, shared by every adapter.
 */

/** The most probable level; on a tie the higher level wins, erring toward more effort. */
export function argmaxHigh(probabilities: Record<string, number>): number {
  let best = -1
  let bestP = -Infinity
  for (const [key, p] of Object.entries(probabilities)) {
    const level = Number(key)
    if (p > bestP || (p === bestP && level > best)) {
      best = level
      bestP = p
    }
  }
  return best
}

/**
 * (n·p_max − 1)/(n − 1), clamped to [0, 1]. `n` is the number of
 * options asked, not the number of keys: a zero-probability option may be
 * missing from the map.
 */
export function confidenceOf(probabilities: Record<string, number>, n: number): number | null {
  const values = Object.values(probabilities)
  if (values.length === 0 || n < 2) return null
  const pMax = Math.max(...values)
  return Math.min(1, Math.max(0, (n * pMax - 1) / (n - 1)))
}
