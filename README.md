# roadsage-alerts

Live road alerts (police, hazards, crashes, closures) for the RoadSage app.

A small [Hono](https://hono.dev) server that keeps a logged-in Waze realtime session for
each device and serves the alerts inside whatever box the device asks for, over a
WebSocket. Alerts are cached in Redis and shared between devices.

```
RoadSage app ──WebSocket──▶ api (Hono, Node) ──HTTPS (optional proxy)──▶ Waze rt
                               │        │
                               ▼        ▼
                             redis    /data/devices.json
```

No Waze account has to be supplied. A device registers its id once, and the server creates
an anonymous Waze account for it, the same kind the Waze app makes on first launch.

## Run it

```bash
cp .env.example .env    # set API_KEY for anything public
docker compose up -d
curl localhost:8080/health
```

`docker compose` starts two services on a private `roadsage-alerts` network: `api`
(published on `PORT`) and `redis` (not published). To build the image locally instead of
pulling it, add `--build`.

The `data` volume holds the device registry. Keep it across upgrades: without it every
device gets a new Waze account the next time it registers.

## Configuration

| Variable | Meaning |
|---|---|
| `PORT` | Host port for the API (default 8080) |
| `API_KEY` | Shared key clients send as `Authorization: Bearer <key>`. Empty = open (local only) |
| `REDIS_URL` | Redis connection. Compose points this at the bundled service. Unset = in-memory |
| `DATA_DIR` | Directory for the device registry, `devices.json` (default `./data`; `/data` in the image) |
| `MAX_DEVICES` | Most devices the server will register, so most Waze accounts it will create (default 50) |
| `WAZE_PROXY` | Optional `http://user:pass@host:port` proxy for the Waze connection |
| `ALERT_TTL_MINUTES` | How long an alert is kept after it was last reported (default 45) |

Waze refuses requests from many datacenter address ranges. From a home connection no proxy
is needed; elsewhere set `WAZE_PROXY` to a proxy with residential exits.

## API

- `GET /health` — liveness, store status, upstream session state
- `GET /health/upstream` — one credential-free request to Waze, to check the route out
- `PUT /v1/devices/<id>` — register a device
- `GET /v1/stream?device=<id>[&channel=<name>]` — WebSocket
- `GET /v1/limits/12/<x>/<y>` — posted speed limits in one z12 map tile, as `{ ways: { <OSM way id>: <mph> } }`. Read from OpenStreetMap (Overpass) on first request and kept in Redis for 30 days; a first request can take up to a minute

### Devices

A device id is 8–64 characters of letters, digits, `.`, `-` and `_`; an app generates one
(a UUID) on first launch and keeps it. Before opening a stream the app registers it:

```bash
curl -X PUT localhost:8080/v1/devices/3F2A9C0E-7B1D-4E55-9A10-2C6D8E4F0B21
# 201 {"device":"…","created":true}    first time: the Waze account was just created
# 200 {"device":"…","created":false}   already registered
```

Registering is safe to repeat. It answers `403` once `MAX_DEVICES` devices exist, `502`
if Waze refused to create an account, and `503` with `Retry-After` while the server is
backing off after such a refusal. Accounts are created one at a time.

Each device has its own Waze account and its own session, opened when its first stream
connects and closed a minute after its last one goes. A device may hold several streams,
one box each (say the drive loop and a map screen): give each a different `channel`.
They share the device's session.

### Stream

WebSocket frames are JSON:

```jsonc
// app → server: the box to watch (replaces the previous one)
{ "type": "view", "south": 41.80, "west": -87.72, "north": 41.95, "east": -87.55 }
{ "type": "loc", "lat": 41.88, "lon": -87.63, "span": 0.05 }   // shorthand: box around a point

// server → app
{ "type": "ready" }
{ "type": "alerts", "generatedAt": 1795530000000, "view": { … },
  "complete": true, "truncated": false,
  "alerts": [{ "id": "…", "type": "POLICE", "subtype": "POLICE_VISIBLE",
               "lat": 41.9, "lon": -87.6, "street": "…", "city": "…", "pubMillis": 1795529990000 }] }
{ "type": "error", "error": "…" }
{ "type": "error", "code": "unregistered", "error": "…" }   // then the socket closes: register, reconnect
```

Each `alerts` frame carries everything known inside the current box, so a client replaces
what it shows. `complete` is `false` while the box is still being scanned; `truncated` means
the box was too large or dense to cover in one pass (zoom in).

Try it:

```bash
node scripts/stream-test.mjs 41.8781 -87.6298 0.08 --base http://localhost:8080
```

## How a box is covered

Waze answers one view with at most roughly 20–30 alerts and sends each alert only once per
session. So the server scans a box as a quadtree, on the device's own session: ask for a tile, and if it now holds 18 or
more alerts, split it in four and ask again, down to about 1.3 km tiles. Once covered, the
finished tiles are re-asked every 20 seconds, which returns only new reports. Removals are
not parsed; alerts expire after `ALERT_TTL_MINUTES`.

## Develop

```bash
pnpm install
pnpm dev          # tsx watch, reads .env
pnpm type-check
```

The image is built and pushed to `ghcr.io/acvigue/roadsage-alerts` on every push to `main`.
