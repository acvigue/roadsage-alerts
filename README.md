# roadsage-alerts

Live road alerts (police, hazards, crashes, closures) for the RoadSage app.

A small [Hono](https://hono.dev) server that keeps a logged-in Waze realtime session and
serves the alerts inside whatever box a connected device asks for, over a WebSocket.
Alerts are cached in Redis and shared between devices.

```
RoadSage app ──WebSocket──▶ api (Hono, Node) ──HTTPS (optional proxy)──▶ Waze rt
                               │
                               ▼
                             redis
```

## Run it

```bash
cp .env.example .env    # fill in WAZE_ACCOUNTS, and API_KEY for anything public
docker compose up -d
curl localhost:8080/health
```

`docker compose` starts two services on a private `roadsage-alerts` network: `api`
(published on `PORT`) and `redis` (not published). To build the image locally instead of
pulling it, add `--build`.

## Configuration

| Variable | Meaning |
|---|---|
| `PORT` | Host port for the API (default 8080) |
| `API_KEY` | Shared key clients send as `Authorization: Bearer <key>`. Empty = open (local only) |
| `REDIS_URL` | Redis connection. Compose points this at the bundled service. Unset = in-memory |
| `WAZE_ACCOUNTS` | JSON array `[{"username":"…","password":"…"}]`; one shared session per account |
| `WAZE_PROXY` | Optional `http://user:pass@host:port` proxy for the Waze connection |
| `ALERT_TTL_MINUTES` | How long an alert is kept after it was last reported (default 45) |

Waze refuses requests from many datacenter address ranges. From a home connection no proxy
is needed; elsewhere set `WAZE_PROXY` to a proxy with residential exits.

## API

- `GET /health` — liveness, store status, upstream session state
- `GET /health/upstream` — one credential-free request to Waze, to check the route out
- `GET /v1/stream?device=<id>` — WebSocket

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
session. So the server scans a box as a quadtree: ask for a tile, and if it now holds 18 or
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
