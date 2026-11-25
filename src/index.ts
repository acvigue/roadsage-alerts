/**
 * roadsage-alerts — live road alerts for the RoadSage app.
 *
 *   GET /health              liveness + store + upstream session state
 *   GET /health/upstream     one credential-free request to Waze (is the route out working?)
 *   PUT /v1/devices/:id      register a device; its Waze account is created on first use
 *   GET /v1/stream?device=   WebSocket: alerts for the box the app sends (see scanner.ts)
 */
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono, type MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { config } from './config.js'
import { DeviceRegistry, RegistrationRefused, validDeviceId } from './devices.js'
import { MemoryStore, RedisStore, type AlertStore } from './store.js'
import { Sessions, probeWaze } from './upstream.js'
import { Watcher } from './scanner.js'
import type { Account } from './waze/client.js'

const ttlMs = config.alertTtlMinutes * 60_000
const store: AlertStore = config.redisUrl ? new RedisStore(config.redisUrl, ttlMs) : new MemoryStore(ttlMs)

// One anonymous Waze account per registered device; nothing to configure.
const registry = new DeviceRegistry(join(config.dataDir, 'devices.json'), config.wazeProxy, config.maxDevices)
await registry.load()
const sessions = new Sessions(config.wazeProxy, store)
if (process.env.WAZE_ACCOUNTS) {
  console.warn('[boot] WAZE_ACCOUNTS is no longer used (every device gets its own account): remove it from the environment')
}

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
    devices: { registered: registry.size, limit: registry.limit },
    streams: watchers.size,
    upstreams: sessions.states,
  }, storeOk ? 200 : 503)
})

app.get('/health/upstream', authenticate, async c => {
  try {
    const r = await probeWaze(config.wazeProxy)
    return c.json({ ok: r.status === 200, proxied: !!config.wazeProxy, ...r }, r.status === 200 ? 200 : 502)
  } catch (err) {
    return c.json({ ok: false, proxied: !!config.wazeProxy, error: String(err) }, 502)
  }
})

app.put('/v1/devices/:id', authenticate, async c => {
  const device = c.req.param('id')
  if (!validDeviceId(device)) return c.json({ error: 'invalid device id' }, 400)
  try {
    const { created } = await registry.ensure(device)
    return c.json({ device, created }, created ? 201 : 200)
  } catch (err) {
    if (!(err instanceof RegistrationRefused)) throw err
    if (err.retryAfterS) c.header('Retry-After', String(err.retryAfterS))
    return c.json({ error: err.message }, err.status)
  }
})

app.get('/v1/stream', authenticate, upgradeWebSocket(c => {
  const device = c.req.query('device') ?? ''
  // One device may hold several streams (one box each); the channel tells them apart.
  const channel = c.req.query('channel') ?? ''
  let watcher: Watcher | null = null
  let account: Account | undefined
  const end = () => {
    if (!watcher) return
    watcher.close()
    watchers.delete(watcher)
    watcher = null
    if (account) sessions.release(account)
  }
  return {
    onOpen(_evt, ws) {
      const send = (frame: unknown) => { try { ws.send(JSON.stringify(frame)) } catch { /* socket gone */ } }
      const refuse = (code: string, error: string) => { send({ type: 'error', code, error }); ws.close(4400, code) }
      if (!validDeviceId(device)) return refuse('bad_device', 'missing or invalid device id')
      account = registry.get(device)
      if (!account) return refuse('unregistered', 'device not registered: PUT /v1/devices/<id> first')
      watcher = new Watcher(channel ? `${device}/${channel}` : device, sessions.acquire(account), store, send)
      watchers.add(watcher)
      void watcher.run().catch(err => console.error('[watch] crashed', err))
    },
    onMessage(evt) {
      if (typeof evt.data === 'string') watcher?.onMessage(evt.data)
    },
    onClose: end,
    onError: end,
  }
}))

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, info => {
  console.log(`[boot] listening on :${info.port}`, {
    store: store.kind, devices: registry.size,
    proxied: !!config.wazeProxy, auth: !!config.apiKey,
  })
})
injectWebSocket(server)

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    for (const w of watchers) w.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
