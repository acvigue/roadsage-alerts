/**
 * Waze realtime (rt) client: log an account in and ask for the alerts in a
 * view. Protocol notes:
 *
 *   1. POST /rtserver/distrib/login   body: ProtoBase64,<Batch{ClientInfo}>   -> cookies
 *      (the Waze-Session-Affinity cookie pins later requests to one backend)
 *   2. POST /rtserver/distrib/command batch{ClientInfo, login_request{password_credential}}
 *                                      -> LoginResponse{login_success{secret_key}}
 *   3. uid header = base64(UID{ id = user_id from the token, secret_key = token })
 *   4. POST /command  "SetMood,321\nLocation,lon,lat\nMapDisplayed,<viewport>"
 *      with the uid header + cookies
 *      -> Batch with element 2708 = com.waze.proto.alertsonmap.AddAlertAction
 */

const HOST = 'rt-xlb-am.waze.com'
const UA = 'Waze/0 CFNetwork/3896.300.31 Darwin/27.3.0'
// ---- base64 <-> bytes ----
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function bytesToB64(b: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i])
  return btoa(bin)
}

// ---- protobuf (minimal) ----
function encVarint(n: number): number[] {
  let bi = BigInt(Math.trunc(n))
  if (bi < 0n) bi += 1n << 64n // negative int64 => 64-bit two's complement
  const out: number[] = []
  do {
    const b = Number(bi & 0x7fn)
    bi >>= 7n
    out.push(b | (bi > 0n ? 0x80 : 0))
  } while (bi > 0n)
  return out
}
const tag = (f: number, w: number) => encVarint((f << 3) | w)
function pbStr(f: number, s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s))
  return [...tag(f, 2), ...encVarint(bytes.length), ...bytes]
}
function pbBytes(f: number, b: number[]): number[] {
  return [...tag(f, 2), ...encVarint(b.length), ...b]
}
function pbInt(f: number, v: number): number[] {
  return [...tag(f, 0), ...encVarint(v)]
}
function element(num: number, payload: number[]): number[] {
  return pbBytes(num, payload) // Batch repeated Element = field 1001; here num is the element field
}
function batch(...els: number[][]): number[] {
  const out: number[] = []
  for (const e of els) out.push(...pbBytes(1001, e))
  return out
}

interface Field { n: number; w: number; v: bigint | Uint8Array }
function decode(buf: Uint8Array): Map<number, Field[]> {
  const out = new Map<number, Field[]>()
  let i = 0
  const rv = (): bigint => {
    let s = 0n, val = 0n
    while (true) {
      const c = buf[i++]; val |= BigInt(c & 0x7f) << s
      if (!(c & 0x80)) break
      s += 7n
    }
    return val
  }
  while (i < buf.length) {
    const key = Number(rv()); const n = key >> 3; const w = key & 7
    let v: bigint | Uint8Array
    if (w === 0) v = rv()
    else if (w === 2) { const ln = Number(rv()); v = buf.slice(i, i + ln); i += ln }
    else if (w === 5) { v = buf.slice(i, i + 4); i += 4 }
    else if (w === 1) { v = buf.slice(i, i + 8); i += 8 }
    else break
    const list = out.get(n) ?? []
    list.push({ n, w, v }); out.set(n, list)
  }
  return out
}
const asBytes = (f?: Field): Uint8Array => (f && f.v instanceof Uint8Array ? f.v : new Uint8Array())
const asBig = (f?: Field): bigint => (f && typeof f.v === 'bigint' ? f.v : 0n)
const asNum = (f?: Field): number => Number(asBig(f))
const asStr = (f?: Field): string => (f && f.v instanceof Uint8Array ? new TextDecoder().decode(f.v) : '')
const sub = (m: Map<number, Field[]>, n: number) => decode(asBytes(m.get(n)?.[0]))

// One installation id per process, like a freshly installed app.
const INSTALLATION_ID = crypto.randomUUID().toUpperCase()
// Where the "device" says it last was. Only used to pick the server region.
const HOME = { lat: 39.8283, lon: -98.5795 }

/** ClientInfo (element 2184) describing an iOS Waze client. */
function clientInfoPayload(): number[] {
  const micro = (v: number) => Math.round(v * 1e6)
  return [
    ...pbInt(1, 234),
    ...pbStr(3, '5.27.5.0'),
    ...pbBytes(4, [...pbInt(101, micro(HOME.lon)), ...pbInt(102, micro(HOME.lat))]),
    ...pbStr(5, 'Apple'),
    ...pbStr(6, 'iPhone 17 Pro Max'),
    ...pbInt(8, 1320), ...pbInt(9, 2868),
    ...pbStr(11, '27.3'),
    ...pbInt(15, 0),
    ...pbStr(16, 'en'),
    ...pbStr(17, INSTALLATION_ID),
    ...pbInt(18, 21), ...pbInt(19, 1),
    ...pbBytes(22, pbBytes(1, [...pbStr(1, 'uid_enabled'), ...pbStr(2, 'true')])),
    ...pbStr(23, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'),
    ...pbBytes(24, [...pbInt(1, 2), ...pbInt(2, 1320), ...pbInt(3, 2868)]),
    ...pbStr(25, 'en-US'),
    ...pbInt(27, 0),
    ...pbInt(28, Date.now()),
    ...pbInt(30, 0), ...pbInt(31, 1),
  ]
}

export interface WazeSession { host: string; cookie: string; uidHeader: string; userId: number }
export interface Alert {
  id: string; type: number; subtype: number; lat: number; lon: number
  description: string; reporter: string; street: string; city: string
}

/** One HTTP reply, however it was carried (fetch, or a proxied socket). */
export interface HttpReply {
  status: number
  header(name: string): string | null
  setCookie: string[]
  body: Uint8Array
}
/** How requests reach the rt host (direct, or through a proxy: see transport.ts). */
export interface Transport {
  post(path: string, body: Uint8Array | string, headers: Record<string, string>): Promise<HttpReply>
}
export const WAZE_HOST = HOST

function mergeCookies(r: HttpReply, prev = ''): string {
  const jar = new Map<string, string>()
  for (const part of prev.split('; ')) { const j = part.indexOf('='); if (j > 0) jar.set(part.slice(0, j), part.slice(j + 1)) }
  for (const sc of r.setCookie) { const c = sc.split(';')[0]; const j = c.indexOf('='); if (j > 0) jar.set(c.slice(0, j).trim(), c.slice(j + 1)) }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

function post(t: Transport, path: string, body: Uint8Array | string, cookie: string, uid?: string, waitMs = 0): Promise<HttpReply> {
  const h: Record<string, string> = {
    'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
    Accept: '*/*', 'x-waze-network-version': '3',
  }
  if (cookie) h['Cookie'] = cookie
  if (uid) h['uid'] = uid
  if (waitMs) h['x-waze-wait-timeout'] = String(waitMs)
  return t.post(path, body, h)
}

const printable = (b: Uint8Array): string =>
  JSON.stringify(Array.from(b, c => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join(''))

/** Compact dump of a protobuf message for diagnostics: {field:value,...}. */
function dump(buf: Uint8Array, depth = 0): string {
  const parts: string[] = []
  for (const [n, fields] of decode(buf)) {
    for (const f of fields) {
      if (typeof f.v === 'bigint') { parts.push(`${n}:${f.v}`); continue }
      const text = Array.from(f.v).every(c => c >= 32 && c < 127)
      if (text && f.v.length) parts.push(`${n}:${printable(f.v.slice(0, 80))}`)
      else if (depth < 3 && f.v.length) parts.push(`${n}:${dump(f.v, depth + 1)}`)
      else parts.push(`${n}:<${f.v.length}b>`)
    }
  }
  return `{${parts.join(',')}}`.slice(0, 400)
}

/**
 * user_id from a (base64, already unescaped) ClientAuthToken, or null unless it
 * has exactly the known shape {1:key 2:issued 3 4 5:user_id 6:global_id
 * 7:signature} and field 6 matches the global id the login response reported.
 */
export function tokenUserId(token: string, globalId: string): number | null {
  if (token.length % 4 === 1) return null
  let raw: Uint8Array
  try { raw = b64ToBytes(token) } catch { return null }
  const order: number[] = []
  let i = 0, uid = 0, gid = 0n
  const rv = (): bigint => {
    let sh = 0n, val = 0n
    while (true) {
      if (i >= raw.length) throw new Error('eof')
      const c = raw[i++]; val |= BigInt(c & 0x7f) << sh
      if (!(c & 0x80)) return val
      sh += 7n
    }
  }
  try {
    while (i < raw.length) {
      const key = Number(rv()); const n = key >> 3; const w = key & 7
      if (w === 0) { const v = rv(); if (n === 5) uid = Number(v); if (n === 6) gid = v }
      else if (w === 2) { const len = Number(rv()); i += len; if (i > raw.length) return null }
      else return null
      order.push(n)
    }
  } catch { return null }
  if (order.join(',') !== '1,2,3,4,5,6,7') return null
  if (/^[0-9]+$/.test(globalId) && gid !== BigInt(globalId)) return null
  return uid
}

/** '9' is the token's escape character: "99" = 9, "9a"/"9b" = the two specials. */
export const unescapeToken = (t: string, a: string, b: string): string =>
  t.replace(/9(.)/g, (m, c) => (c === '9' ? '9' : c === 'a' ? a : c === 'b' ? b : m))

/** Log in an account and return a usable rt session (uid header + affinity cookie). */
export async function login(username: string, password: string, t: Transport): Promise<WazeSession> {
  const ci = clientInfoPayload()
  // 1. /login bootstrap -> affinity cookie
  const loginBody = 'ProtoBase64,' + bytesToB64(new Uint8Array(batch(element(2184, ci)))) + '\nGetGeoServerConfig,,'
  const r1 = await post(t, '/rtserver/distrib/login', loginBody, '')
  let cookie = mergeCookies(r1)
  // 2. login_request{ password_credential{username,password}, reason=1 } + client_info
  const pwCred = [...pbStr(1, username), ...pbStr(2, password)]
  const loginReq = [...pbBytes(1, pwCred), ...pbInt(3, 1)]  // LoginRequest
  const bodyBytes = new Uint8Array(batch(element(2184, ci), element(2744, loginReq)))
  const r2 = await post(t, '/rtserver/distrib/command?sessionid=-1&cookie=', 'ProtoBase64,' + bytesToB64(bodyBytes), cookie)
  cookie = mergeCookies(r2, cookie)
  const respBytes = r2.body
  // find element 2745 login_response -> field1 login_success -> field3 secret_key
  let secret = ''
  let globalId = ''
  for (const el of decode(respBytes).get(1001) ?? []) {
    const ed = decode(asBytes(el))
    const lr = ed.get(2745)
    if (lr) {
      const success = sub(decode(asBytes(lr[0])), 1)
      secret = asStr(success.get(3)?.[0])
      globalId = asStr(success.get(2)?.[0]).split('|').pop() ?? ''   // "1|global|<n>"
      break
    }
  }
  if (!secret) {
    // Say what Waze actually answered (never the credentials): HTTP status, the
    // elements in the reply, and the login_response body if there was one.
    const els = (decode(respBytes).get(1001) ?? []).map(el => decode(asBytes(el)))
    const nums = els.flatMap(e => [...e.keys()])
    const lr = els.find(e => e.has(2745))?.get(2745)?.[0]
    const detail = lr ? dump(asBytes(lr)) : printable(respBytes.slice(0, 200))
    throw new Error(`login failed: no secret_key (bootstrap http ${r1.status}, http ${r2.status}, via ${r2.header('via')}, elements [${nums.join(',')}], ${lr ? 'login_response' : 'body'} ${detail})`)
  }
  // uid.id = ClientAuthToken field 5 (user_id), sign-folded if > int32max.
  // The token arrives '9'-escaped (see unescapeToken) and has to be unescaped
  // before decoding; decoded as-is, everything after the first 9 is shifted,
  // field 5 is garbage and the server answers "Unknown userid". The header
  // still carries the token exactly as received.
  const cands: number[] = []
  for (const [a, b] of [['+', '/'], ['/', '+']]) {
    const id = tokenUserId(unescapeToken(secret, a, b), globalId)
    if (id !== null && !cands.includes(id)) cands.push(id)
  }
  if (cands.length === 0) throw new Error(`login failed: unparseable auth token (len ${secret.length})`)
  const session = (id: number): WazeSession => {
    const uidNum = id > 0x7fffffff ? id - 2 ** 32 : id
    const uidHeader = bytesToB64(new Uint8Array([...pbInt(1, uidNum), ...pbStr(2, secret)]))
    return { host: HOST, cookie, uidHeader, userId: uidNum }
  }
  // Which of 9a/9b is '+' only matters when one lands inside field 5. Then the
  // two readings differ, and a snapshot poll says which one the server knows.
  if (cands.length > 1) {
    try { await poll(t, session(cands[0]), HOME.lat, HOME.lon, 0.01) }
    catch (err) {
      if ((err as { needsRelogin?: boolean }).needsRelogin) return session(cands[1])
      throw err
    }
  }
  return session(cands[0])
}

/** Half-extent of a view: one number for a square, or separate lat/lon halves. */
export type Span = number | { lat: number; lon: number }

function mapDisplayed(lat: number, lon: number, span: Span): string {
  const f = (v: number) => v.toFixed(6)
  const hLat = typeof span === 'number' ? span : span.lat
  const hLon = typeof span === 'number' ? span : span.lon
  // Corners MUST go round the box (TL, TR, BR, BL). In TL,TR,BL,BR order the
  // polygon crosses itself and the server returns no alerts for it at all.
  const ring = (k: number) => [f(lon - hLon * k), f(lat + hLat * k), f(lon + hLon * k), f(lat + hLat * k),
    f(lon + hLon * k), f(lat - hLat * k), f(lon - hLon * k), f(lat - hLat * k)]
  return 'MapDisplayed,' + [...ring(1), f(lon), f(lat), '7042', ...ring(0.6)].join(',')
}

/**
 * Ask for the alerts in a view. The server answers at once with what it has not
 * yet sent THIS SESSION for that view, capped at roughly 20-30 alerts; a repeat
 * of the same view returns only what is new since. Callers that want everything
 * in an area must split full views (see scanner.ts).
 */
export async function poll(t: Transport, sess: WazeSession, lat: number, lon: number, span: Span = 0.03, waitMs = 0): Promise<Alert[]> {
  const body = `SetMood,321\nLocation,${lon.toFixed(6)},${lat.toFixed(6)}\n${mapDisplayed(lat, lon, span)}`
  const r = await post(t, '/rtserver/distrib/command?sessionid=-1&cookie=', body, sess.cookie, sess.uidHeader, waitMs)
  if (r.status !== 200) throw new Error(`poll failed: http ${r.status}`)
  const txt = new TextDecoder().decode(r.body.slice(0, 160))
  if (/relogin|Unknown userid|UID expected|IllegalArgument/.test(txt)) {
    const err = new Error('session not active') as Error & { needsRelogin?: boolean }
    err.needsRelogin = true
    throw err
  }
  return parseAlerts(r.body)
}

function signedMicro(f?: Field): number {
  let b = asBig(f)
  if (b >= 1n << 63n) b -= 1n << 64n // int64 two's complement (negative longitude)
  return Number(b) / 1e6
}

export function parseAlerts(buf: Uint8Array): Alert[] {
  const out: Alert[] = []
  for (const el of decode(buf).get(1001) ?? []) {
    const ed = decode(asBytes(el))
    for (const act of ed.get(2708) ?? []) {       // add_alert_action
      const ra = sub(decode(asBytes(act)), 1)      // realtime_alert
      const ai = sub(ra, 2)                        // alert_info
      const pos = sub(ai, 3)                       // position {101=lon, 102=lat}
      const ari = sub(ra, 3)                       // alert_reporting_info
      const addr = sub(ari, 8)                     // alert_address {2=street,3=city}
      const lon = signedMicro(pos.get(101)?.[0])
      const lat = signedMicro(pos.get(102)?.[0])
      out.push({
        id: String(asNum(ra.get(1)?.[0])),
        type: asNum(ai.get(1)?.[0]),
        subtype: asNum(ai.get(2)?.[0]),
        lon, lat,
        description: asStr(ari.get(3)?.[0]),
        reporter: asStr(ari.get(5)?.[0]),
        street: asStr(addr.get(2)?.[0]),
        city: asStr(addr.get(3)?.[0]),
      })
    }
  }
  return out
}

// com.waze.proto.alertsonmap.AlertType
export const ALERT_TYPE: Record<number, string> = {
  1: 'CHIT_CHAT', 2: 'POLICE', 3: 'ACCIDENT', 4: 'JAM', 5: 'TRAFFIC_INFO', 6: 'HAZARD',
  7: 'MISC', 8: 'CONSTRUCTION', 9: 'PARKING', 10: 'DYNAMIC', 11: 'CAMERA', 13: 'ROAD_CLOSED',
  14: 'SYSTEM_ROAD_CLOSED', 16: 'SOS', 17: 'CRASH_PRONE', 19: 'TURN_CLOSED', 20: 'ANIMAL',
}
// com.waze.proto.alertsonmap.AlertSubType (names RoadAlert.detail recognises)
export const ALERT_SUBTYPE: Record<number, string> = {
  201: 'POLICE_VISIBLE', 202: 'POLICE_HIDING', 203: 'POLICE_WITH_MOBILE_CAMERA',
  301: 'ACCIDENT_MINOR', 302: 'ACCIDENT_MAJOR',
  401: 'JAM_MODERATE_TRAFFIC', 402: 'JAM_HEAVY_TRAFFIC', 403: 'JAM_STAND_STILL_TRAFFIC', 404: 'JAM_LIGHT_TRAFFIC',
  601: 'HAZARD_ON_ROAD', 602: 'HAZARD_ON_SHOULDER', 603: 'HAZARD_WEATHER',
  604: 'HAZARD_ON_ROAD_OBJECT', 605: 'HAZARD_ON_ROAD_POT_HOLE', 606: 'HAZARD_ON_ROAD_ROAD_KILL',
  607: 'HAZARD_ON_SHOULDER_CAR_STOPPED', 608: 'HAZARD_ON_SHOULDER_ANIMALS',
  610: 'HAZARD_WEATHER_FOG', 612: 'HAZARD_WEATHER_HEAVY_RAIN', 613: 'HAZARD_WEATHER_HEAVY_SNOW',
  614: 'HAZARD_WEATHER_FLOOD', 620: 'HAZARD_ON_ROAD_LANE_CLOSED', 622: 'HAZARD_ON_ROAD_ICE',
  623: 'HAZARD_ON_ROAD_CONSTRUCTION', 624: 'HAZARD_ON_ROAD_CAR_STOPPED',
  626: 'HAZARD_ON_ROAD_EMERGENCY_VEHICLE',
  1301: 'ROAD_CLOSED_HAZARD', 1302: 'ROAD_CLOSED_CONSTRUCTION', 1303: 'ROAD_CLOSED_EVENT',
}
