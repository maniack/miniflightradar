# Mini Flightradar PWA

A small demo service to track flights via the OpenSky API: Go backend + PWA frontend (React), Prometheus metrics, and OpenTelemetry tracing. This README reflects the current codebase and routes.

## Requirements

- Go 1.24+
- Node.js 20+
- Docker (optional)

## Quick start (Go)

Recommended: build via Makefile (includes frontend) and run the binary:

```bash
make all
./bin/mini-flightradar --listen ":8080"
```

Alternative (step-by-step):

```bash
# 1) build the frontend and copy it to ui/build (embedded into the binary)
make frontend
# 2) build the backend (embeds static files from ui/build)
make backend
# 3) run
./bin/mini-flightradar --listen ":8080"
```

Once started, the UI is available at http://localhost:8080

## Build with Makefile

```bash
make all              # builds frontend and backend, puts the binary into bin/
./bin/mini-flightradar --listen ":8080"
```

Useful targets:
- make frontend — build the React frontend and copy to ui/build
- make backend  — build the Go binary (uses vendoring)
- make docker   — build a Docker image
- make clean    — remove artifacts (bin/, ui/build)

## Docker build and run

```bash
docker build -t miniflightradar .
docker run --rm -p 8080:8080 -v $(pwd)/data:/app/data --name minifr miniflightradar
```

The container listens on 8080. The frontend static assets are embedded into the Go binary; the final image copies only the executable. Mount a volume at /app/data to persist the DB and secrets across restarts (as in the example above).

## Configuration: flags and environment variables

CLI flags (aliases in parentheses):
- server.listen (--listen, -l) — HTTP server address, default `:8080`.
- server.proxy  (--proxy,  -x) — proxy URL for outbound requests (http/https/socks5). Example: `--proxy socks5://127.0.0.1:1080`.
- tracing.endpoint (--tracing, -t) — OpenTelemetry collector endpoint for traces (either `host:port` or full URL), e.g. `otel-collector:4318`.
- storage.path (--db) — path to BuntDB file, default `./data/flight.buntdb`.
- opensky.interval (--interval, -i) — OpenSky polling interval, default `60s`.
- opensky.retention (--retention, -r) — history retention, default `168h` (1 week).
- opensky.user — OpenSky username (optional, for Basic Auth).
- opensky.pass — OpenSky password (optional, for Basic Auth).
- debug (-d) — enable verbose logging.

You can also configure proxies via standard Linux-style environment variables:
- HTTP_PROXY / http_proxy
- HTTPS_PROXY / https_proxy
- ALL_PROXY / all_proxy
- NO_PROXY / no_proxy

Hidden flags for JWT secret management:
- security.jwt.secret — explicit secret (HS256) to sign cookies.
- security.jwt.file — path to secret file (default `./data/jwt.secret`). If `security.jwt.secret` is empty, the secret is loaded from the file or generated and saved on disk.

## HTTP and WebSocket endpoints

Currently exposed endpoints (as wired in app/run.go):
- GET /api/flights — all current flight positions (array of objects with fields `icao24,callsign,lon,lat,alt,track,speed,ts`). Used by the UI as a fallback.
- WS /ws/flights — live stream of position diffs for all current flights. Requires cookies and CSRF (see Security). The client must pass `?csrf=<value of mfr_csrf cookie>` and send ACK frames of the form `{"type":"ack","seq":N,"buffered":bytes}`. Each upsert item may include a short `trail` (last ~24 points over ~45 minutes).
  - The server periodically sends heartbeat messages `{"type":"hb","ts":<unix>}` to keep the connection alive.
  - On graceful shutdown the server notifies all WS clients `{"type":"server_shutdown","ts":<unix>}`.
- GET /metrics — Prometheus metrics.
- GET /healthz — simple unauthenticated health endpoint (200 OK + JSON). Intended for external liveness checks; the frontend relies on the WebSocket (onopen/onclose + heartbeats) for availability.
- POST /otel/v1/traces — OTLP/HTTP proxy for the frontend; the server forwards to the collector specified via `--tracing.endpoint`.

Note: Handlers exist in code for additional routes like `/api/flight?callsign=...`, `/api/flights?bbox=...`, and `/api/track?callsign=...`, but these are not currently mounted in the router. Only `/api/flights` is exposed via HTTP in the current wiring.

## Observability

- Prometheus: `/metrics` with counters/histograms for HTTP and flight operations.
- OpenTelemetry: server creates spans for HTTP; responses include `X-Trace-Id` for correlation. The web client can send traces to `/otel/v1/traces` (see above).
- Logs: structured single-line logs with fields method, path, status, duration, remote, ua, trace_id, span_id, request_id.
- Caching: a global middleware adds strong ETags for GET/HEAD and honors `If-None-Match`.
- Request ID: each request includes and logs an `X-Request-ID`.

## Security

- Cookies: on first visit the server issues two cookies — `mfr_jwt` (JWT HS256, ~30 days, HttpOnly, SameSite=Lax) and `mfr_csrf` (CSRF token, readable by JS).
- API protection: for `/api/*` routes (except `/metrics`) the server requires header `X-CSRF-Token` to match the `mfr_csrf` cookie and a valid `mfr_jwt`.
- WebSocket `/ws/flights`: requires a valid `mfr_jwt` and the CSRF token passed as the `csrf` query parameter.
- JWT secret: set via `security.jwt.secret` or stored/generated in the file at `security.jwt.file` (default `./data/jwt.secret`).

## Data and persistence

- Storage — BuntDB (key/value). Default file: `./data/flight.buntdb`.
- Old points are purged automatically via TTL (flag `--opensky.retention`, default 1 week).
- For Docker, mount the `data/` directory to persist state between restarts.

## OpenSky: polling and backoff

- Base polling interval is controlled by `--opensky.interval` (default 60s).
- On 429/503 responses the ingestor applies backoff: the next request is delayed per `Retry-After` or at least the base interval. Current points are prolonged so markers don’t disappear during backoff.
- When `opensky.user`/`opensky.pass` are provided, Basic Auth is used (limits may differ).

## UI/UX

- Top bar: search by callsign and Search button. When a filter is active, only the selected flight and its track are shown.
- Bottom-left: map layer toggle — OSM (follows light/dark theme) and Hybrid (satellite + labels).
- Without a filter, the UI shows all available flights in the current viewport; data arrives via WebSocket diffs.
- Icons are bundled locally (`@fortawesome/fontawesome-free`); no external CDNs are used. Responsive layout via Flexbox.

## Development

- Frontend: `cd frontend && npm start`
- Backend: `go run ./cmd/miniflightradar --listen :8080`

The UI talks to API/WS on the same host/port.

### Quality checks and CI

- Locally:
  - Linters: `golangci-lint run` (or `make lint`) — requires golangci-lint installed.
  - Static analysis: `go vet ./...` (or `make vet`).
  - Tests (if any are added): `go test ./...` (or `make test`).
- CI: a GitHub Actions workflow `.github/workflows/go.yml` runs `go build`, `go vet` and `golangci-lint` on each push/PR (main/master branches). Vendoring is used (`GOFLAGS=-mod=vendor`).

## Troubleshooting

- If static assets are missing, build the frontend: `make frontend` (this produces `ui/build`).
- To quickly test the backend only, you can run `make backend` (build the UI first if you want the assets embedded).
- In Docker, mount `-v $(pwd)/data:/app/data` so the DB and secrets are preserved.

## Security and dependency hygiene

- Frontend dependencies are pinned and production builds use `npm ci`; the UI is embedded into the Go binary, and Node tooling is not present in the final image.
- Current audit status: no critical/high production vulnerabilities; the CRA dev server may have moderate advisories relevant only to local development.
- Run an audit locally: `cd frontend && npm audit --omit=dev`.

## License

This project is licensed under the MIT License. See the LICENSE file for details.

## Third‑party licenses and attributions

The project uses the following third‑party software and data. Please review and comply with their licenses and terms when deploying this application:

- OpenLayers (package `ol`) — BSD 2‑Clause license.
  - Copyright © OpenLayers Contributors.
  - https://openlayers.org/
  - https://github.com/openlayers/openlayers/blob/main/LICENSE.md

- Font Awesome Free (`@fortawesome/fontawesome-free`) — Code under MIT, icons under CC BY 4.0.
  - https://github.com/FortAwesome/Font-Awesome/blob/6.x/LICENSE.txt

- OpenStreetMap data and tiles — © OpenStreetMap contributors, ODbL 1.0 for data; tile usage subject to provider terms.
  - https://www.openstreetmap.org/copyright
  - Attribution is shown in the map UI as required.

- CARTO Basemaps (Dark Matter OSM tiles) — usage subject to CARTO terms; attribution required (shown in UI).
  - https://carto.com/basemaps/

- Esri World Imagery and reference overlays — usage subject to Esri Terms of Use; attribution required (shown in UI).
  - https://www.esri.com/en-us/legal/terms/full-master-agreement
  - https://www.esri.com/en-us/legal/terms/data-attributions

- OpenSky Network API — subject to OpenSky Network Terms of Use and API limitations.
  - https://opensky-network.org/
  - https://openskynetwork.github.io/opensky-api/
  - We respect rate limits and include attribution in the UI.

Notes:
- This application fetches map tiles from external providers (OSM/CARTO/Esri). Ensure your deployment complies with their usage policies (e.g., fair use, API keys if required, proper attribution).
- The backend may use your OpenSky credentials (opensky.user/opensky.pass flags) if provided; ensure your use complies with OpenSky’s ToS.