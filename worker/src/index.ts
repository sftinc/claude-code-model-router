/**
 * model-router-api: HTTP only. It never sees a classifier's own format; that
 * lives behind the adapter (classifiers/jev.ts).
 */
import { jev } from './classifiers/jev'
import { isSituation, type Env } from './types'

const MAX_BODY_BYTES = 256 * 1024

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers })

/** Constant-time comparison over the UTF-8 bytes. */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url)
    if (pathname === '/health' && req.method === 'GET') return json({ ok: true })
    if (pathname !== '/v1/classify' || req.method !== 'POST') return json({ error: 'not found' }, 404)

    // Before any comparison: with the secret unset, "Bearer undefined" would match.
    if (!env.ROUTER_SECRET) return json({ error: 'not configured' }, 500)
    if (!safeEqual(req.headers.get('authorization') ?? '', `Bearer ${env.ROUTER_SECRET}`)) {
      return json({ error: 'unauthorized' }, 401)
    }

    // The limit is in bytes, checked on the declared length first, then on what arrived.
    if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) return json({ error: 'body too large' }, 400)
    const bytes = await req.arrayBuffer()
    if (bytes.byteLength > MAX_BODY_BYTES) return json({ error: 'body too large' }, 400)

    let situation: unknown
    try {
      situation = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return json({ error: 'invalid json' }, 400)
    }
    if (!isSituation(situation)) return json({ error: 'invalid situation' }, 400)

    try {
      const verdict = await jev.classify(situation, env, {
        id: env.GATEWAY_ID,
        skipCache: true,
        collectLog: env.COLLECT_LOG !== 'false',
        metadata: { source: situation.source, classifier: jev.id, version: env.CF_VERSION_METADATA.id },
      })
      return json(verdict, 200, { 'x-aig-log-id': env.AI.aiGatewayLogId ?? '' })
    } catch (err) {
      return json({ error: String(err) }, 502)
    }
  },
}
