/**
 * The HTTP path to Waze: one kept-alive connection per transport, optionally
 * through an HTTP CONNECT proxy. A single connection means every request of a
 * session leaves from the same address and reaches the same Waze backend.
 */
import { Agent, ProxyAgent, request, type Dispatcher } from 'undici'
import { WAZE_HOST, type HttpReply, type Transport } from './client.js'

export interface ClosableTransport extends Transport {
  readonly proxied: boolean
  close(): Promise<void>
}

export function makeTransport(proxyUrl: string, timeoutMs = 30_000): ClosableTransport {
  const common = { connections: 1, keepAliveTimeout: 60_000, connect: { timeout: timeoutMs } }
  let dispatcher: Dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, ...common }) : new Agent(common)
  return {
    proxied: !!proxyUrl,
    async post(path, body, headers): Promise<HttpReply> {
      const r = await request(`https://${WAZE_HOST}${path}`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : Buffer.from(body),
        dispatcher,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      })
      const bytes = new Uint8Array(await r.body.arrayBuffer())
      const get = (name: string) => r.headers[name.toLowerCase()]
      const sc = get('set-cookie')
      return {
        status: r.statusCode,
        header: name => { const v = get(name); return v === undefined ? null : Array.isArray(v) ? v[0] : v },
        setCookie: sc === undefined ? [] : Array.isArray(sc) ? sc : [sc],
        body: bytes,
      }
    },
    async close() {
      const d = dispatcher
      dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, ...common }) : new Agent(common)
      await d.destroy().catch(() => {})
    },
  }
}
