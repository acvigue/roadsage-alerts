/**
 * Device registry — which Waze account belongs to which app install.
 *
 * A device registers its id once (PUT /v1/devices/<id>). The server then
 * creates an anonymous Waze account for it and keeps it, so the device always
 * logs in as the same account and never shares a session with another device.
 *
 * Records live in one JSON file (DATA_DIR/devices.json). Unlike the alerts in
 * Redis they must outlive restarts: losing them means creating every account
 * again.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { register, type Account } from './waze/client.js'
import { makeTransport } from './waze/transport.js'

export interface DeviceRecord extends Account {
  createdAt: number
}

/** 8-64 characters: letters, digits, dot, dash, underscore (a UUID fits). */
export const validDeviceId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/.test(id)

/** A registration the server will not attempt; `status` is the HTTP answer. */
export class RegistrationRefused extends Error {
  constructor(message: string, readonly status: 403 | 502 | 503, readonly retryAfterS?: number) { super(message) }
}

const GAP_MS = 2_000 // between two account creations
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export class DeviceRegistry {
  private devices = new Map<string, DeviceRecord>()
  /** Registrations in flight, so two requests for one device create one account. */
  private pending = new Map<string, Promise<DeviceRecord>>()
  private chain: Promise<unknown> = Promise.resolve()
  private lastAt = 0
  private failures = 0
  private retryAt = 0

  constructor(private file: string, private proxyUrl: string, private maxDevices: number) {}

  /** Read the file. A missing file is an empty registry; an unreadable one is fatal. */
  async load(): Promise<void> {
    let text: string
    try { text = await readFile(this.file, 'utf8') }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    const parsed = JSON.parse(text) as { devices?: Record<string, DeviceRecord> }
    for (const [id, r] of Object.entries(parsed.devices ?? {})) {
      if (validDeviceId(id) && r?.username && r?.password) this.devices.set(id, r)
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify({ version: 1, devices: Object.fromEntries(this.devices) }, null, 1), { mode: 0o600 })
    await rename(tmp, this.file)
  }

  get size(): number { return this.devices.size }
  get limit(): number { return this.maxDevices }
  get(id: string): DeviceRecord | undefined { return this.devices.get(id) }

  /** The device's record, creating its Waze account if this is the first time. */
  async ensure(id: string): Promise<{ record: DeviceRecord; created: boolean }> {
    const known = this.devices.get(id)
    if (known) return { record: known, created: false }
    let p = this.pending.get(id)
    if (!p) {
      p = this.create(id).finally(() => this.pending.delete(id))
      this.pending.set(id, p)
    }
    return { record: await p, created: true }
  }

  /** One account creation at a time, spaced out, and none while Waze is refusing them. */
  private create(id: string): Promise<DeviceRecord> {
    const job = async (): Promise<DeviceRecord> => {
      if (this.devices.size >= this.maxDevices) {
        throw new RegistrationRefused(`device limit reached (${this.maxDevices})`, 403)
      }
      const wait = this.retryAt - Date.now()
      if (wait > 0) {
        throw new RegistrationRefused('Waze is refusing new accounts; try again later', 503, Math.ceil(wait / 1000))
      }
      await sleep(Math.max(0, this.lastAt + GAP_MS - Date.now()))
      const t = makeTransport(this.proxyUrl)
      try {
        this.lastAt = Date.now()
        const a = await register(t)
        const record: DeviceRecord = { ...a, createdAt: Date.now() }
        this.devices.set(id, record)
        try { await this.save() }
        catch (e) { this.devices.delete(id); throw e }
        this.failures = 0
        console.log('[devices] registered', { devices: this.devices.size })
        return record
      } catch (e) {
        if (e instanceof RegistrationRefused) throw e
        // Back off 1, 2, 4, 8, then 15 minutes, as for refused logins.
        this.failures++
        this.retryAt = Date.now() + Math.min(15, 2 ** (this.failures - 1)) * 60_000
        console.error('[devices] registration failed', { failures: this.failures, err: (e as Error).message })
        throw new RegistrationRefused(`could not create an account: ${(e as Error).message}`, 502)
      } finally {
        await t.close()
      }
    }
    const p = this.chain.then(job, job)
    this.chain = p.catch(() => {})
    return p
  }
}
