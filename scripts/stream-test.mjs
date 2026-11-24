#!/usr/bin/env node
// Connect to /v1/stream like the app does, ask for one box, print what arrives.
//   node scripts/stream-test.mjs [lat lon halfDeg] [--base https://host] [--key API_KEY]
const args = process.argv.slice(2)
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined }
const base = opt('--base') ?? 'http://localhost:8080'
const key = opt('--key')
const [lat, lon, half] = [Number(args[0] ?? 41.8781), Number(args[1] ?? -87.6298), Number(args[2] ?? 0.08)]
const url = base.replace(/^http/, 'ws') + `/v1/stream?device=stream-test-${Date.now()}`
const ws = new WebSocket(url, key ? { headers: { Authorization: `Bearer ${key}` } } : undefined)
const t0 = Date.now()
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`
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
