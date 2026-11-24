/**
 * Watcher — one connected device and the box it is looking at.
 *
 * WS protocol (JSON text frames):
 *   app -> server: { "type": "view", "south", "west", "north", "east" }
 *                  { "type": "loc",  "lat", "lon", "span"?: <deg> }   box around a point
 *   server -> app: { "type": "ready" }
 *                  { "type": "alerts", "generatedAt", "view", "complete", "truncated",
 *                    "alerts": [{ id, type, subtype?, lat, lon, street?, city?, description?, pubMillis }] }
 *                  { "type": "error", "error": "<msg>" }
 *
 * Every "alerts" frame carries everything known inside the current box, so the
 * app replaces what it shows. `complete` is false while the box is still being
 * scanned; `truncated` means it was too large or dense to cover in one pass.
 *
 * Covering a box: ask Waze for it; if it now holds FULL or more alerts it may
 * be hiding others (Waze caps a view at ~20-30), so split it in four and ask
 * again, down to MIN_HALF. Afterwards the finished tiles are re-asked every
 * REFRESH_MS, which returns only alerts reported since.
 */
import type { Upstream } from './upstream.js'
import type { AlertStore } from './store.js'
import { tileView, type Tile, type View } from './geo.js'

const FULL = 18
const MIN_HALF = 0.006     // ~0.65 km
const MAX_HALF = 0.75      // a box is scanned at most this far from its centre
const SCAN_BUDGET = 48     // requests per full scan of one box
const REFRESH_MS = 20_000

export class Watcher {
  private view: View | null = null
  private seq = 0
  private wake: (() => void) | null = null
  private closed = false

  constructor(
    readonly device: string,
    private upstream: Upstream,
    private store: AlertStore,
    private send: (frame: unknown) => void
  ) {}

  onMessage(data: string) {
    let m: any
    try { m = JSON.parse(data) } catch { return }
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
    let v: View | null = null
    if (m?.type === 'view' && num(m.south) && num(m.west) && num(m.north) && num(m.east) && m.north > m.south && m.east > m.west) {
      v = { south: m.south, west: m.west, north: m.north, east: m.east }
    } else if (m?.type === 'loc' && num(m.lat) && num(m.lon)) {
      const s = num(m.span) && m.span > 0 && m.span <= 0.2 ? m.span : 0.03
      v = { south: m.lat - s, west: m.lon - s, north: m.lat + s, east: m.lon + s }
    }
    if (!v || v.south < -90 || v.north > 90) return
    this.view = v
    this.seq++
    this.wake?.()
  }

  close() {
    this.closed = true
    this.wake?.()
  }

  /** Sleep that a new box (or a disconnect) cuts short. */
  private nap(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); if (this.wake === done) this.wake = null; resolve() }
      const timer = setTimeout(done, ms)
      this.wake = done
    })
  }

  private async push(v: View, complete: boolean, truncated: boolean) {
    const alerts = await this.store.inBox(v)
    this.send({ type: 'alerts', generatedAt: Date.now(), view: v, complete, truncated, alerts })
  }

  async run() {
    this.send({ type: 'ready' })
    let failures = 0
    while (!this.closed) {
      if (!this.view) { await this.nap(30_000); continue }
      try {
        await this.cover()
        failures = 0
      } catch (e) {
        failures++
        this.send({ type: 'error', error: (e as Error).message })
        await this.nap(Math.min(60_000, 3000 * 2 ** Math.min(failures - 1, 5)))
      }
    }
  }

  private async cover() {
    const seq = this.seq
    const v = this.view!
    const stale = () => this.closed || this.seq !== seq
    const root: Tile = {
      lat: (v.south + v.north) / 2, lon: (v.west + v.east) / 2,
      hLat: Math.min(MAX_HALF, (v.north - v.south) / 2),
      hLon: Math.min(MAX_HALF, (v.east - v.west) / 2),
    }
    const clamped = root.hLat < (v.north - v.south) / 2 || root.hLon < (v.east - v.west) / 2

    await this.push(v, false, false) // whatever is already known, at once

    const leaves: Tile[] = []
    const queue: Tile[] = [root]
    let asks = 0
    while (queue.length && !stale()) {
      const t = queue.shift()!
      if (asks >= SCAN_BUDGET) { leaves.push(t); continue }
      const fresh = await this.upstream.ask(t); asks++
      if (stale()) return
      const count = (await this.store.inBox(tileView(t))).length
      if (count >= FULL && t.hLat / 2 >= MIN_HALF) {
        const hLat = t.hLat / 2, hLon = t.hLon / 2
        for (const [i, j] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          queue.push({ lat: t.lat + i * hLat, lon: t.lon + j * hLon, hLat, hLon })
        }
      } else leaves.push(t)
      if (fresh) await this.push(v, false, false)
    }
    if (stale()) return
    const truncated = clamped || asks >= SCAN_BUDGET
    await this.push(v, true, truncated)
    console.log('[watch] box covered', { device: this.device, asks, tiles: leaves.length, truncated })

    while (!stale()) {
      await this.nap(REFRESH_MS)
      for (const t of leaves) {
        if (stale()) return
        await this.upstream.ask(t)
      }
      if (stale()) return
      await this.push(v, true, truncated)
    }
  }
}
