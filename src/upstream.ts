/**
 * Upstream — one logged-in Waze session on one connection, for one device's
 * account. Requests are strictly one at a time.
 *
 * Two things shape how it is used:
 *   - Waze answers a view with at most ~20-30 alerts, and
 *   - it sends each alert only once per session.
 * So a view is covered by asking for tiles and splitting the full ones (see
 * scanner.ts), and everything received goes into the shared store.
 */
import { login, poll, ALERT_TYPE, ALERT_SUBTYPE, type Account, type WazeSession } from './waze/client.js'
import { makeTransport, type ClosableTransport } from './waze/transport.js'
import type { AlertStore, StoredAlert } from './store.js'
import { tileKey, type Tile } from './geo.js'

const GAP_MS = 150          // breathing room between requests
const REASK_MS = 10_000     // a tile asked this recently is not asked again
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export class Upstream {
  private transport: ClosableTransport
  private session: WazeSession | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private asked = new Map<string, number>()
  private failures = 0
  private retryAt = 0
  private lastError = ''

  stats = { logins: 0, polls: 0, alerts: 0, lastLoginAt: 0, lastPollAt: 0 }

  constructor(private account: Account, proxyUrl: string, private store: AlertStore) {
    this.transport = makeTransport(proxyUrl)
  }

  get state() {
    return {
      account: this.account.username.replace(/(?<=.{2}).(?=.{2})/g, '*'),
      loggedIn: !!this.session,
      proxied: this.transport.proxied,
      waitingUntil: this.retryAt > Date.now() ? this.retryAt : null,
      lastError: this.lastError || null,
      ...this.stats,
    }
  }

  private run<T>(job: () => Promise<T>): Promise<T> {
    const p = this.chain.then(job, job)
    this.chain = p.catch(() => {})
    return p
  }

  private async ensureSession(): Promise<WazeSession> {
    if (this.session) return this.session
    const wait = this.retryAt - Date.now()
    if (wait > 0) throw new Error(`${this.lastError} (next login attempt in ${Math.ceil(wait / 1000)} s)`)
    try {
      const t0 = Date.now()
      this.session = await login(this.account, this.transport)
      this.failures = 0
      this.lastError = ''
      this.asked.clear() // a new session has been sent nothing yet
      this.stats.logins++
      this.stats.lastLoginAt = Date.now()
      console.log('[upstream] logged in', { ms: Date.now() - t0, proxied: this.transport.proxied })
      return this.session
    } catch (e) {
      // A refused login is not retried for 1, 2, 4, 8, then 15 minutes: every
      // extra attempt on a throttled account pushes its recovery further out.
      this.failures++
      this.retryAt = Date.now() + Math.min(15, 2 ** (this.failures - 1)) * 60_000
      this.lastError = (e as Error).message
      await this.transport.close()
      console.error('[upstream] login failed', { failures: this.failures, err: this.lastError })
      throw e
    }
  }

  /** Ask Waze for one tile; returns how many alerts were new to the store. */
  ask(t: Tile): Promise<number> {
    return this.run(async () => {
      const k = tileKey(t)
      const now = Date.now()
      if (now - (this.asked.get(k) ?? 0) < REASK_MS) return 0
      for (let attempt = 0; ; attempt++) {
        const sess = await this.ensureSession()
        try {
          const got = await poll(this.transport, sess, t.lat, t.lon, { lat: t.hLat, lon: t.hLon })
          this.asked.set(k, Date.now())
          if (this.asked.size > 5000) for (const [key, at] of this.asked) if (now - at > REASK_MS) this.asked.delete(key)
          this.stats.polls++
          this.stats.alerts += got.length
          this.stats.lastPollAt = Date.now()
          const seen = Date.now()
          const fresh = await this.store.put(got.map((a): StoredAlert => ({
            id: a.id, lat: a.lat, lon: a.lon,
            type: ALERT_TYPE[a.type] ?? `AOM_${a.type}`,
            subtype: ALERT_SUBTYPE[a.subtype] || undefined,
            street: a.street || undefined,
            city: a.city || undefined,
            description: a.description || undefined,
            pubMillis: seen,
          })))
          await sleep(GAP_MS)
          return fresh
        } catch (e) {
          // The session or the connection died; either way start clean once.
          this.session = null
          await this.transport.close()
          if (attempt >= 1) throw e
        }
      }
    })
  }

  /** Drop the session and its connection (after the queued requests finish). */
  close(): Promise<void> {
    return this.run(async () => {
      this.session = null
      await this.transport.close()
    })
  }
}

/** Can we reach Waze at all? No credentials involved. */
export async function probeWaze(proxyUrl: string): Promise<{ status: number; bytes: number; ms: number }> {
  const t = makeTransport(proxyUrl, 20_000)
  try {
    const t0 = Date.now()
    const r = await t.post('/rtserver/distrib/login', 'GetGeoServerConfig,,', {
      'User-Agent': 'Waze/0 CFNetwork/3896.300.31 Darwin/27.3.0',
      'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*', 'x-waze-network-version': '3',
    })
    return { status: r.status, bytes: r.body.length, ms: Date.now() - t0 }
  } finally {
    await t.close()
  }
}

/**
 * The upstream sessions in use, one per device (so per account). A session is
 * opened when the device's first stream needs it and closed a minute after its
 * last one goes, so a device that drops and reconnects keeps its session.
 */
export class Sessions {
  private live = new Map<string, { up: Upstream; refs: number; timer?: NodeJS.Timeout }>()

  constructor(private proxyUrl: string, private store: AlertStore, private idleMs = 60_000) {}

  acquire(account: Account): Upstream {
    let s = this.live.get(account.username)
    if (!s) {
      s = { up: new Upstream(account, this.proxyUrl, this.store), refs: 0 }
      this.live.set(account.username, s)
    }
    clearTimeout(s.timer)
    s.timer = undefined
    s.refs++
    return s.up
  }

  release(account: Account): void {
    const s = this.live.get(account.username)
    if (!s || --s.refs > 0) return
    s.timer = setTimeout(() => {
      this.live.delete(account.username)
      void s.up.close().catch(() => {})
    }, this.idleMs)
    s.timer.unref()
  }

  get states() { return [...this.live.values()].map(s => ({ streams: s.refs, ...s.up.state })) }
}

