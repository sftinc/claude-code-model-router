import { describe, expect, test, vi } from 'vitest'
import worker from '../src/index'
import type { Env } from '../src/types'

const SECRET = 'test-secret'

const JEV_OK = {
  model: 'jev-1.13.0',
  answers: {
    tier: { choice: 'balanced', probabilities: { fast: 0.1, balanced: 0.8, deep: 0.1 }, confidence: 0.7 },
    effort: { probabilities: { '0': 0.05, '1': 0.2, '2': 0.6, '3': 0.15 }, confidence: 0.47 },
    risky: { noul: 0.04 },
  },
  usage: {},
}

function envWith(run: Env['AI']['run'] = vi.fn(async () => JEV_OK), overrides: Partial<Env> = {}): Env {
  return {
    AI: { run, aiGatewayLogId: 'log-123' },
    ROUTER_SECRET: SECRET,
    GATEWAY_ID: 'model-router',
    COLLECT_LOG: 'true',
    CF_VERSION_METADATA: { id: 'ver-1' },
    ...overrides,
  }
}

function post(body: unknown, auth: string | null = `Bearer ${SECRET}`): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (auth !== null) headers.authorization = auth
  return new Request('https://api.test/v1/classify', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const MAIN = { source: 'main', prompt: 'rename getUser to fetchUser' }

describe('worker', () => {
  test('GET /health answers without auth or a model call', async () => {
    const env = envWith()
    const res = await worker.fetch(new Request('https://api.test/health'), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  test('any other route is 404', async () => {
    const res = await worker.fetch(new Request('https://api.test/v1/systemone', { method: 'POST' }), envWith())
    expect(res.status).toBe(404)
  })

  test('an unset secret is 500 before any comparison, so "Bearer undefined" never matches', async () => {
    const env = envWith(undefined, { ROUTER_SECRET: undefined })
    const res = await worker.fetch(post(MAIN, 'Bearer undefined'), env)
    expect(res.status).toBe(500)
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  test('a missing or wrong bearer is 401 with no model call', async () => {
    const env = envWith()
    expect((await worker.fetch(post(MAIN, null), env)).status).toBe(401)
    expect((await worker.fetch(post(MAIN, 'Bearer wrong'), env)).status).toBe(401)
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  test('invalid JSON or an invalid situation is 400', async () => {
    const env = envWith()
    expect((await worker.fetch(post('{nope'), env)).status).toBe(400)
    expect((await worker.fetch(post({ source: 'other', prompt: 'x' }), env)).status).toBe(400)
    expect((await worker.fetch(post({ source: 'main', prompt: '' }), env)).status).toBe(400)
    expect((await worker.fetch(post({ source: 'main', prompt: 'x', recent: [{ role: 'user' }] }), env)).status).toBe(400)
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  test('a body over 256 KB in bytes is refused even when it is under 256 K characters', async () => {
    const env = envWith()
    const prompt = 'é'.repeat(140_000) // 140 000 characters, 280 000 bytes in UTF-8
    const res = await worker.fetch(post({ source: 'main', prompt }), env)
    expect(res.status).toBe(400)
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  test('a model error or an answer the adapter cannot normalize is 502', async () => {
    const throwing = envWith(vi.fn(async () => { throw new Error('gateway down') }))
    expect((await worker.fetch(post(MAIN), throwing)).status).toBe(502)
    const odd = envWith(vi.fn(async () => ({ model: 'jev', answers: {} })))
    expect((await worker.fetch(post(MAIN), odd)).status).toBe(502)
  })

  test('the happy path returns the verdict, the gateway log id, and tags the gateway call', async () => {
    const env = envWith()
    const res = await worker.fetch(post({ ...MAIN, source: 'subagent', agentType: 'Explore' }), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-aig-log-id')).toBe('log-123')
    expect(await res.json()).toEqual({
      classifier: 'typesafe/jev@jev-1.13.0',
      tier: { value: 'balanced', confidence: 0.7 },
      effort: { level: 2, confidence: 0.47 },
      risky: { p: 0.04 },
    })
    expect(env.AI.run).toHaveBeenCalledWith('typesafe/jev', expect.anything(), {
      gateway: {
        id: 'model-router',
        skipCache: true,
        collectLog: true,
        metadata: { source: 'subagent', classifier: 'jev', version: 'ver-1' },
      },
    })
  })

  test('COLLECT_LOG=false turns gateway logging off', async () => {
    const env = envWith(undefined, { COLLECT_LOG: 'false' })
    await worker.fetch(post(MAIN), env)
    expect(env.AI.run).toHaveBeenCalledWith('typesafe/jev', expect.anything(), {
      gateway: expect.objectContaining({ collectLog: false }),
    })
  })
})
