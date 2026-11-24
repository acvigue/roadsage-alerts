/**
 * roadsage-alerts — live road alerts for the RoadSage app.
 *
 *   GET /health            liveness + store + upstream session state
 *   GET /health/upstream   one credential-free request to Waze (is the route out working?)
 *   GET /v1/stream?device= WebSocket: alerts for the box the app sends (see scanner.ts)
 */
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono, type MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { config } from './config.js'
import { MemoryStore, RedisStore, type AlertStore } from './store.js'
import { Upstream } from './upstream.js'
import { Watcher } from './scanner.js'
import { loadPool, pickIndex } from './waze/accounts.js'

const ttlMs = config.alertTtlMinutes * 60_000
const store: AlertStore = config.redisUrl ? new RedisStore(config.redisUrl, ttlMs) : new MemoryStore(ttlMs)

const pool = loadPool(config.wazeAccounts)
const upstreams = pool.map(a => new Upstream(a, config.wazeProxy, store))
if (!upstreams.length) console.warn('[boot] WAZE_ACCOUNTS is empty: streams will connect but report an error')

const watchers = new Set<Watcher>()

const authenticate: MiddlewareHandler = async (c, next) => {
  if (!config.apiKey) return next()
  const h = c.req.header('authorization')
  const given = Buffer.from(h?.startsWith('Bearer ') ? h.slice(7) : (c.req.header('x-api-key') ?? ''))
  const want = Buffer.from(config.apiKey)
  if (given.length !== want.length || !timingSafeEqual(given, want)) return c.json({ error: 'unauthorized' }, 401)
  return next()
}

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

app.onError((err, c) => {
  console.error('unhandled', err)
  return c.json({ error: 'internal error' }, 500)
})

app.get('/health', async c => {
  const storeOk = await store.ping()
  return c.json({
    status: storeOk ? 'ok' : 'degraded',
    store: { kind: store.kind, ok: storeOk },
    devices: watchers.size,
    upstreams: upstreams.map(u => u.state),
  }, storeOk ? 200 : 503)
})

app.get('/health/upstream', authenticate, async c => {
  const u = upstreams[0] ?? new Upstream({ username: '', password: '' }, config.wazeProxy, store)
  try {
    const r = await u.probe()
    return c.json({ ok: r.status === 200, proxied: !!config.wazeProxy, ...r }, r.status === 200 ? 200 : 502)
  } catch (err) {
    return c.json({ ok: false, proxied: !!config.wazeProxy, error: String(err) }, 502)
  }
})

app.get('/v1/stream', authenticate, upgradeWebSocket(c => {
  const device = c.req.query('device') || crypto.randomUUID()
  let watcher: Watcher | null = null
  return {
    onOpen(_evt, ws) {
      const send = (frame: unknown) => { try { ws.send(JSON.stringify(frame)) } catch { /* socket gone */ } }
      if (!upstreams.length) { send({ type: 'error', error: 'no Waze accounts configured (WAZE_ACCOUNTS)' }); return }
      watcher = new Watcher(device, upstreams[pickIndex(upstreams.length, device)], store, send)
      watchers.add(watcher)
      void watcher.run().catch(err => console.error('[watch] crashed', err))
    },
    onMessage(evt) {
      if (typeof evt.data === 'string') watcher?.onMessage(evt.data)
    },
    onClose() {
      if (watcher) { watcher.close(); watchers.delete(watcher) }
    },
    onError() {
      if (watcher) { watcher.close(); watchers.delete(watcher) }
    },
  }
}))

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, info => {
  console.log(`[boot] listening on :${info.port}`, { store: store.kind, accounts: upstreams.length, proxied: !!config.wazeProxy, auth: !!config.apiKey })
})
injectWebSocket(server)

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    for (const w of watchers) w.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
