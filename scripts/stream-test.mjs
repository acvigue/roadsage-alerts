#!/usr/bin/env node
// Do what the app does: register a device id, open /v1/stream, ask for one box, print what arrives.
//   node scripts/stream-test.mjs [lat lon halfDeg] [--base https://host] [--key API_KEY] [--device ID]
// The device id defaults to a fixed one: every new id makes the server create
// another Waze account, so do not randomise it.
const args = process.argv.slice(2)
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined }
const base = opt('--base') ?? 'http://localhost:8080'
const key = opt('--key')
const device = opt('--device') ?? 'stream-test-device'
const [lat, lon, half] = [Number(args[0] ?? 41.8781), Number(args[1] ?? -87.6298), Number(args[2] ?? 0.08)]
const headers = key ? { Authorization: `Bearer ${key}` } : {}
const t0 = Date.now()
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`

const reg = await fetch(`${base}/v1/devices/${encodeURIComponent(device)}`, { method: 'PUT', headers })
console.log(at(), 'register', reg.status, JSON.stringify(await reg.json().catch(() => null)))
if (!reg.ok) process.exit(1)

const url = base.replace(/^http/, 'ws') + `/v1/stream?device=${encodeURIComponent(device)}`
const ws = new WebSocket(url, key ? { headers } : undefined)
ws.onopen = () => {
  console.log(at(), 'open', url)
  ws.send(JSON.stringify({ type: 'view', south: lat - half, west: lon - half, north: lat + half, east: lon + half }))
}
ws.onmessage = ev => {
  const m = JSON.parse(ev.data)
  if (m.type !== 'alerts') return console.log(at(), JSON.stringify(m))
  const by = {}
  for (const a of m.alerts) by[a.type] = (by[a.type] ?? 0) + 1
  console.log(at(), `alerts ${String(m.alerts.length).padStart(4)}  complete=${m.complete} truncated=${m.truncated}  ${JSON.stringify(by)}`)
}
ws.onclose = ev => { console.log(at(), 'closed', ev.code, ev.reason); process.exit(0) }
ws.onerror = ev => console.log(at(), 'error', ev.message ?? '')
setTimeout(() => ws.close(), 60_000)
