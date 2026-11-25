/** Everything the server reads from the environment, in one place. */
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d)

export const config = {
  port: num(process.env.PORT, 8080),
  /** Shared client key (Bearer). Unset = open, for local development only. */
  apiKey: process.env.API_KEY ?? '',
  /** redis://host:6379 — unset keeps alerts in memory (single process, lost on restart). */
  redisUrl: process.env.REDIS_URL ?? '',
  /** Directory for what must survive a restart: the device registry (devices.json). */
  dataDir: process.env.DATA_DIR || './data',
  /** Most devices (so, Waze accounts) the server will ever register. */
  maxDevices: num(process.env.MAX_DEVICES, 50),
  /**
   * Optional HTTP proxy for the Waze connection: http://user:pass@host:port.
   * Waze refuses many datacenter addresses; from a home connection leave unset.
   */
  wazeProxy: process.env.WAZE_PROXY ?? '',
  /** How long an alert stays after it was last reported, in minutes. */
  alertTtlMinutes: num(process.env.ALERT_TTL_MINUTES, 45),
}
