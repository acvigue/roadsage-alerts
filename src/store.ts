/**
 * Where alerts live between being received from Waze and being sent to apps.
 * Shared by every connected device, so one device's scan serves the next.
 *
 * Redis layout:
 *   alerts:geo        GEO set of alert ids
 *   alert:<id>        JSON StoredAlert, expires ALERT_TTL after it was last reported
 * Waze removals are not parsed, so expiry is what retires an alert.
 */
import { Redis } from 'ioredis'
import { inView, type View } from './geo.js'

export interface StoredAlert {
  id: string
  lat: number
  lon: number
  type: string
  subtype?: string
  street?: string
  city?: string
  description?: string
  /** First time this server saw it (ms). */
  pubMillis: number
}

export interface AlertStore {
  readonly kind: string
  /** Save alerts; returns how many were not known before. */
  put(alerts: StoredAlert[]): Promise<number>
  inBox(v: View): Promise<StoredAlert[]>
  ping(): Promise<boolean>
}

export class MemoryStore implements AlertStore {
  readonly kind = 'memory'
  private items = new Map<string, { a: StoredAlert; until: number }>()
  constructor(private ttlMs: number) {}
  async put(alerts: StoredAlert[]) {
    let fresh = 0
    const until = Date.now() + this.ttlMs
    for (const a of alerts) {
      const old = this.items.get(a.id)
      if (!old) fresh++
      this.items.set(a.id, { a: old ? { ...a, pubMillis: old.a.pubMillis } : a, until })
    }
    return fresh
  }
  async inBox(v: View) {
    const now = Date.now()
    const out: StoredAlert[] = []
    for (const [id, it] of this.items) {
      if (it.until < now) this.items.delete(id)
      else if (inView(it.a, v)) out.push(it.a)
    }
    return out
  }
  async ping() { return true }
}

const GEO = 'alerts:geo'
const key = (id: string) => `alert:${id}`

export class RedisStore implements AlertStore {
  readonly kind = 'redis'
  private redis: Redis
  constructor(url: string, private ttlMs: number) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: true })
    this.redis.on('error', err => console.error('[redis]', err.message))
  }

  async put(alerts: StoredAlert[]) {
    if (!alerts.length) return 0
    const ttl = Math.ceil(this.ttlMs / 1000)
    // NX keeps the first-seen record; a repeat only pushes the expiry out.
    const p = this.redis.pipeline()
    for (const a of alerts) p.set(key(a.id), JSON.stringify(a), 'EX', ttl, 'NX')
    const res = await p.exec()
    const again = this.redis.pipeline()
    let fresh = 0
    alerts.forEach((a, i) => {
      if (res?.[i]?.[1] === 'OK') { fresh++; again.geoadd(GEO, a.lon, a.lat, a.id) }
      else again.expire(key(a.id), ttl)
    })
    await again.exec()
    return fresh
  }

  async inBox(v: View) {
    const lat = (v.south + v.north) / 2, lon = (v.west + v.east) / 2
    // GEOSEARCH wants metres; pad a little and filter exactly afterwards.
    const h = (v.north - v.south) * 111_320 * 1.05 + 50
    const w = (v.east - v.west) * 111_320 * Math.cos((Math.min(Math.abs(v.south), Math.abs(v.north)) * Math.PI) / 180) * 1.05 + 50
    const ids = (await this.redis.geosearch(GEO, 'FROMLONLAT', lon, lat, 'BYBOX', w, h, 'm')) as string[]
    if (!ids.length) return []
    const raw = await this.redis.mget(ids.map(key))
    const out: StoredAlert[] = []
    const gone: string[] = []
    raw.forEach((s, i) => {
      if (!s) { gone.push(ids[i]); return }
      const a = JSON.parse(s) as StoredAlert
      if (inView(a, v)) out.push(a)
    })
    if (gone.length) void this.redis.zrem(GEO, ...gone).catch(() => {})
    return out
  }

  async ping() {
    try { return (await this.redis.ping()) === 'PONG' } catch { return false }
  }
}
