/**
 * Posted speed limits, from OpenStreetMap.
 *
 * The app's road graph is cut from OSM and every edge carries its OSM way id,
 * so a limit is looked up by way id: no geometry matching. Limits are served
 * per z12 map tile as { wayId: mph } and kept for a month: they rarely change
 * and the public Overpass servers are slow and rate-limited.
 */
import { Redis } from 'ioredis'

export const LIMIT_ZOOM = 12
const KEEP_S = 30 * 24 * 3600
/** An area that failed is not asked for again for this long. */
const RETRY_MS = 5 * 60_000

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

export type Limits = Record<string, number>

export function tileBounds(x: number, y: number, z = LIMIT_ZOOM) {
  const n = 2 ** z
  const lat = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI
  return { south: lat(y + 1), west: (x / n) * 360 - 180, north: lat(y), east: ((x + 1) / n) * 360 - 180 }
}

/**
 * An OSM maxspeed value in miles per hour, or null when it is not a number
 * ("signals", "none", "walk", a conditional…). A bare number is km/h.
 */
export function parseMaxspeed(raw: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph|knots)?\s*$/i.exec(raw.split(';')[0] ?? '')
  if (!m) return null
  const v = Number(m[1])
  const unit = (m[2] ?? 'km/h').toLowerCase()
  const mph = unit === 'mph' ? v : unit === 'knots' ? v * 1.15078 : v * 0.621371
  // US signs come in fives; a converted metric value lands a hair off.
  const rounded = unit === 'mph' ? Math.round(mph) : Math.round(mph / 5) * 5
  return rounded >= 5 && rounded <= 100 ? rounded : null
}

export function parseCsv(text: string): Limits {
  const out: Limits = {}
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const id = line.slice(0, tab)
    if (!/^\d+$/.test(id)) continue
    const mph = parseMaxspeed(line.slice(tab + 1))
    if (mph !== null) out[id] = mph
  }
  return out
}

async function fetchTile(x: number, y: number): Promise<Limits> {
  const b = tileBounds(x, y)
  const f = (n: number) => n.toFixed(6)
  const query =
    `[out:csv(::id,maxspeed;false)][timeout:60];` +
    `way[highway][maxspeed](${f(b.south)},${f(b.west)},${f(b.north)},${f(b.east)});out tags;`
  // The public servers differ a lot in speed and availability from one hour
  // to the next, so ask them all and take the first good answer. Results are
  // kept for a month, so this happens rarely.
  const stop = new AbortController()
  const ask = async (url: string) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'roadsage-alerts/1.0' },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(90_000)]),
    })
    const text = await res.text()
    // Overpass answers an overload with 200 and an HTML or XML error page.
    if (!res.ok || text.trimStart().startsWith('<')) throw new Error(`${new URL(url).host}: HTTP ${res.status}`)
    return parseCsv(text)
  }
  try {
    return await Promise.any(MIRRORS.map(ask))
  } catch (err) {
    const first = err instanceof AggregateError ? err.errors[0] : err
    throw new Error('OpenStreetMap lookup failed: ' + (first instanceof Error ? first.message : String(first)))
  } finally {
    stop.abort()
  }
}

export class SpeedLimits {
  private redis: Redis | null
  private memory = new Map<string, Limits>()
  private pending = new Map<string, Promise<Limits>>()
  private failedAt = new Map<string, number>()
  stats = { hits: 0, fetched: 0, failed: 0 }

  constructor(redisUrl: string) {
    this.redis = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: 2 }) : null
    this.redis?.on('error', err => console.error('[limits redis]', err.message))
  }

  /** Limits for one z12 tile. Throws when none are cached and OSM cannot be reached. */
  async tile(x: number, y: number): Promise<Limits> {
    const key = `limits:${LIMIT_ZOOM}:${x}:${y}`
    const cached = this.redis ? await this.redis.get(key).catch(() => null) : null
    if (cached) { this.stats.hits++; return JSON.parse(cached) as Limits }
    const held = this.memory.get(key)
    if (held) { this.stats.hits++; return held }

    const failed = this.failedAt.get(key)
    if (failed && Date.now() - failed < RETRY_MS) throw new Error('speed limit source unavailable, retry later')

    // One request per tile however many clients ask at once.
    let job = this.pending.get(key)
    if (!job) {
      job = fetchTile(x, y)
        .then(async limits => {
          this.stats.fetched++
          this.failedAt.delete(key)
          if (this.redis) await this.redis.set(key, JSON.stringify(limits), 'EX', KEEP_S).catch(() => {})
          else this.memory.set(key, limits)
          return limits
        })
        .catch(err => {
          this.stats.failed++
          this.failedAt.set(key, Date.now())
          throw err
        })
        .finally(() => this.pending.delete(key))
      this.pending.set(key, job)
    }
    return job
  }
}
