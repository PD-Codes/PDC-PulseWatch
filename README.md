# PulseWatch

Self-hosted uptime and status monitoring. Think Uptime Kuma, but built on MariaDB, with multi-location probes, roles and permissions, SSO, long-term rollups and a modern UI.

Copyright (c) PD-Codes. Licensed under [GPL-3.0-only](LICENSE). No telemetry, no phone-home.

- [Quick start](#quick-start)
- [Features](#features)
- [Configuration reference](#configuration-reference)
- [Architecture](#architecture)
- [Probes (multi-location checks)](#probes-multi-location-checks)
- [Backup and restore](#backup-and-restore)
- [Upgrading](#upgrading)
- [Importing from Uptime Kuma](#importing-from-uptime-kuma)
- [Config as code](#config-as-code)
- [Security notes](#security-notes)
- [Development and tests](#development-and-tests)
- [Tested limits](#tested-limits)
- [Surprise features](#surprise-features)
- [Known limitations](#known-limitations)

## Quick start

Requirements: Docker with Compose v2.

```bash
cp .env.example .env
# edit .env: set PW_DB_PASSWORD and PW_BASE_URL (and ideally PW_SECRET_KEY)
docker compose up -d --build
```

Open `http://localhost:3000`. The first visit shows the setup page where you create the administrator account.

Want to look around first? Start with sample data (9 monitors, 90 days of history, a status page at `/status/demo`):

```bash
PW_DEMO=true PW_DEMO_PASSWORD=demo-demo-1 docker compose up -d --build
# sign in as admin / demo-demo-1
```

Demo mode seeds once. Do not enable it on a production database.

Behind a reverse proxy, set `PW_BASE_URL=https://your.host` and `PW_TRUST_PROXY=true`. The base URL is used for links in mails, OIDC callbacks and passkeys. Server-sent events need response buffering turned off (nginx: `proxy_buffering off;` for `/api/stream`).

Useful endpoints: `/health` (liveness), `/ready` (database and scheduler), `/metrics` (Prometheus, see `PW_METRICS_TOKEN`), `/api/docs` (OpenAPI/Swagger UI), `/api/push/<token>` (heartbeats).

## Features

**Monitoring:** HTTP(S) with method/headers/body/auth/status codes/redirects/TLS toggle, keyword and JSON path checks, multi-step HTTP flows, TCP, ICMP ping, UDP, DNS, TLS certificate expiry (with chain), domain/WHOIS expiry, SMTP, IMAP/POP3, SSH banner, WebSocket, gRPC, MQTT, SNMP, MariaDB/MySQL, PostgreSQL, MSSQL, Redis, MongoDB, Docker container state, Minecraft status and push/heartbeat monitors. Every monitor has interval, timeout, retries, up/down thresholds, flap detection, tags, groups, pause/clone/bulk edit and notification rules. Failure modes (DNS, refused, timeout, TLS, wrong status, ...) are distinct error kinds in the event log.

**Operations:** nested groups with dependencies (children are suppressed while a parent is down), automatic and manual incidents with acknowledgement, assignee, notes, post-mortem and MTTR/MTTA, maintenance windows (once or cron, timezone-aware), status pages (custom domain, branding, custom CSS, password or login protection, email/RSS/webhook subscriptions).

**Notifications:** email, Telegram, Discord, Slack, Microsoft Teams, ntfy, Gotify, Pushover and templated webhooks (plus a plugin hook, `registerChannelType`). Templates, escalation policies, quiet hours, per-channel test button and a delivery log with retry.

**Security and users:** local accounts, OIDC (Entra ID, Keycloak, Google, ...), LDAP, TOTP, passkeys (WebAuthn), API tokens with scopes, session management, audit log, roles plus per-group and per-status-page permissions.

**Data:** raw heartbeats roll up to minute, hour and day aggregates (exact percentiles per minute); raw data lives in daily partitions that are dropped by retention. Charts stay fast over years.

**Reports and integrations:** SLA reports as PDF/CSV (also scheduled by mail), daily digest, Prometheus metrics, outgoing webhooks, OpenAPI, Kuma import, YAML/JSON config export and import.

**UI:** light/dark/system theme, German and English (browser language or profile setting), responsive down to phone width, installable PWA, command palette (`Ctrl/Cmd+K`), keyboard shortcuts (`?` lists them), kiosk mode at `/kiosk`, reduced-motion support.

## Configuration reference

Everything is configured through environment variables. Any variable also accepts a `_FILE` variant that reads the value from a file (Docker secrets), e.g. `PW_DB_PASSWORD_FILE=/run/secrets/db`.

### Core

| Variable | Default | Description |
| --- | --- | --- |
| `PW_ROLE` | `all` | `all`, `api` (HTTP only) or `worker` (scheduler, rollups, notifications only). |
| `PW_HOST` | `0.0.0.0` | Listen address. |
| `PW_PORT` | `3000` | Listen port. |
| `PW_BASE_URL` | `http://localhost:3000` | Public URL. Used for links, OIDC redirects, passkey origin. `https://` also turns on secure cookies. |
| `PW_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` from a reverse proxy (client IPs, rate limits). |
| `PW_LOG_LEVEL` | `info` | pino log level. Logs are JSON on stdout. |
| `PW_DATA_DIR` | `./data` (`/data` in the image) | Holds the generated secret key when `PW_SECRET_KEY` is not set. |
| `PW_WEB_DIR` | `./dist/web` | Built UI. |
| `PW_MIGRATIONS_DIR` | `./migrations` | SQL migrations, applied at startup under a database lock. |

### Database

| Variable | Default | Description |
| --- | --- | --- |
| `PW_DB_HOST` | `127.0.0.1` | MariaDB host (`mariadb` in the compose file). |
| `PW_DB_PORT` | `3306` | MariaDB port. |
| `PW_DB_NAME` | `pulsewatch` | Database name. |
| `PW_DB_USER` | `pulsewatch` | Database user. |
| `PW_DB_PASSWORD` | empty | Database password (required by the compose file). |
| `PW_DB_POOL` | `20` | Connection pool size. |

### Secrets and security

| Variable | Default | Description |
| --- | --- | --- |
| `PW_SECRET_KEY` | generated | Master key for encrypting secrets at rest (AES-256-GCM) and signing cookies. If unset, a key file is created in `PW_DATA_DIR`. **Back it up together with the database**, encrypted values cannot be recovered without it. Generate one with `openssl rand -base64 32`. |
| `PW_SESSION_TTL_HOURS` | `168` | Session lifetime. |
| `PW_COOKIE_SECURE` | from `PW_BASE_URL` | Force the `Secure` cookie flag. |
| `PW_SSRF_MODE` | `allow-private` | `allow-private` or `public-only`. Can be overridden at runtime in Settings. |
| `PW_SSRF_ALLOW` | empty | Comma separated IPs/CIDRs exempt from `public-only`. |
| `PW_SSRF_DENY` | empty | Comma separated IPs/CIDRs that are always blocked. Link-local and metadata ranges are blocked by default. |
| `PW_RATE_LIMIT_MAX` | `300` | API requests per minute per client. Static assets and health endpoints are exempt. |
| `PW_RATE_LIMIT_LOGIN` | `10` | Login attempts per minute per client. |
| `PW_METRICS_TOKEN` | empty | Bearer token for `/metrics`. Without it only signed-in administrators can read it. |

### Scheduler and retention

| Variable | Default | Description |
| --- | --- | --- |
| `PW_TICK_MS` | `1000` | Scheduler tick. |
| `PW_MAX_CONCURRENCY` | `200` | Maximum checks running at once. |
| `PW_JITTER_PCT` | `5` | Random spread of the interval, avoids thundering herds. |
| `PW_RETENTION_RAW_DAYS` | `14` | Raw heartbeats (dropped by partition). |
| `PW_RETENTION_MINUTE_DAYS` | `60` | Minute rollups. |
| `PW_RETENTION_HOUR_DAYS` | `400` | Hour rollups. |
| `PW_RETENTION_DAY_DAYS` | `3650` | Day rollups. |
| `PW_RETENTION_EVENT_DAYS` | `365` | Event log. |
| `PW_RETENTION_AUDIT_DAYS` | `730` | Audit log. |

### Email, monitoring of PulseWatch itself, tracing

| Variable | Default | Description |
| --- | --- | --- |
| `PW_SMTP_HOST` / `PW_SMTP_PORT` | empty / `587` | SMTP server for digests, reports and subscription mails. Alert emails use the per-channel SMTP settings. |
| `PW_SMTP_USER` / `PW_SMTP_PASS` | empty | SMTP credentials. |
| `PW_SMTP_FROM` | `PulseWatch <pulsewatch@localhost>` | Sender address. |
| `PW_SMTP_SECURE` | `false` | Implicit TLS (port 465). |
| `PW_DEADMAN_URL` | empty | URL pinged every `PW_DEADMAN_INTERVAL` seconds while the scheduler is healthy. Point it at a push monitor of another PulseWatch (or any heartbeat service) to be alerted when this instance dies. |
| `PW_DEADMAN_INTERVAL` | `60` | Seconds between pings. |
| `PW_OTEL_EXPORTER_OTLP_ENDPOINT` | empty | OTLP/HTTP endpoint (for example `http://collector:4318`). When set, every monitor check is exported as a span to `/v1/traces`. |

### Demo

| Variable | Default | Description |
| --- | --- | --- |
| `PW_DEMO` | `false` | Seed sample data on first start and expose demo target endpoints under `/demo/*`. |
| `PW_DEMO_PASSWORD` | random, logged | Password of the demo `admin` user. |

### Probe agent

| Variable | Default | Description |
| --- | --- | --- |
| `PW_SERVER_URL` | required | Base URL of the PulseWatch server. Must be `https://` (see below). |
| `PW_PROBE_TOKEN` | required | Token shown once when the probe is created. |
| `PW_PROBE_FETCH_SECONDS` | `30` | How often the job list is refreshed. |
| `PW_PROBE_CONCURRENCY` | `50` | Maximum parallel checks. |
| `PW_PROBE_SSRF_MODE` / `_ALLOW` / `_DENY` | `allow-private` | Same semantics as the server variables, applied on the probe. |
| `PW_PROBE_ALLOW_INSECURE` | `false` | Permit a plain `http://` server URL. Only for tests. |

### Docker Compose variables

`PW_IMAGE`, `PW_PROBE_IMAGE`, `PW_PUBLIC_PORT` (host port, default 3000) and `PW_DB_BUFFER_POOL` (MariaDB InnoDB buffer pool, default 256M) only affect the compose file.

## Architecture

```
 browser (React SPA, SSE) ──► app (Fastify API + scheduler + jobs) ──► MariaDB 11
                                   ▲
 probe agents (pull jobs, push results over HTTPS) ┘
```

- **One process by default.** `PW_ROLE=all` runs API, scheduler, rollups, report jobs and the notifier. For bigger setups run `PW_ROLE=api` replicas behind a load balancer and one or more `PW_ROLE=worker` containers (`docker compose --profile split up -d`). Everything coordinates through MariaDB: due checks are claimed with `SELECT ... FOR UPDATE SKIP LOCKED` and a lease, so two workers never run the same check and a crash just lets the lease expire. Redis is not needed.
- **Scheduler** (`src/server/engine`): persisted `next_run_at` per monitor, jitter, concurrency cap, per-check hard timeout, graceful shutdown. A restart neither loses nor duplicates rounds.
- **Check runners** (`src/core/runners`): every monitor type is a self-contained runner with a field definition (drives the UI form and server validation) and a `run()` function. Add a type with `registerRunner`.
- **State machine** (`engine/machine.ts`): retries, up/down thresholds, flap detection, dependency suppression, maintenance overlay, multi-location quorum. Pure and unit-tested.
- **Data** (`migrations/`): versioned SQL migrations. `heartbeats` is partitioned by day; `rollups` holds minute, hour and day aggregates; secrets are stored as `enc:v1:` ciphertext.
- **Realtime:** server-sent events (`/api/stream`), the UI patches its query cache, there is no polling.
- **Notifications** (`src/server/notify`): event bus, per-monitor rules, quiet hours, escalation policies, delivery queue with retries and a log.
- **Auth** (`src/server/auth`): scrypt passwords, TOTP, passkeys, OIDC, LDAP, bearer tokens with scopes, CSRF token bound to the session, audit log.
- **Frontend** (`web/`): React 19, Vite, Tailwind, TanStack Query, uPlot. English and German strings live in `web/src/locales`.
- **Why Node.js and not Go?** The scheduler is I/O bound (sockets, HTTP, DNS), which Node's event loop handles well: 5,000 monitors at 30 s run at about 165 checks per second on 2 vCPUs, see [Tested limits](#tested-limits). One language across API, runners, probe and UI keeps the project small. If you ever need hundreds of thousands of monitors, the probe protocol is simple enough to reimplement the agent in Go.

## Probes (multi-location checks)

A probe is a small agent (`Dockerfile.probe`, about 60 MB) that runs checks from another network and reports back. It only makes outbound connections.

1. In the UI open **Probes** and create a probe. Copy the token, it is shown only once.
2. Run the agent on the remote host:

   ```bash
   docker run -d --restart unless-stopped --name pulsewatch-probe \
     -e PW_SERVER_URL=https://pulsewatch.example.com \
     -e PW_PROBE_TOKEN=pwp_... \
     --cap-drop ALL --cap-add NET_RAW --read-only \
     pulsewatch/probe:latest
   ```

   Or with this repository: `PW_PROBE_TOKEN=pwp_... PW_SERVER_URL=https://... docker compose --profile probe up -d probe`.
3. Edit a monitor, choose its locations (server and/or probes) and set the quorum: the monitor is only down when at least that many locations fail.

**Use HTTPS between probe and server.** Job payloads contain decrypted monitor credentials so the probe can authenticate against your targets. The agent refuses a plain `http://` server URL unless it points to localhost or `PW_PROBE_ALLOW_INSECURE=true`. Tokens can be rotated or a probe disabled at any time without touching monitors.

Probe results are stored when they arrive. The combined verdict for a monitor is evaluated on its normal schedule (and on "Check now"), so a probe-only monitor reacts within one interval.

## Backup and restore

State lives in two places: the **MariaDB database** and the **secret key** (`PW_SECRET_KEY`, or `secret.key` in the `data` volume). Back up both, a database dump without the key cannot be decrypted.

```bash
# Backup (while running)
docker compose exec mariadb sh -c 'mariadb-dump -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" \
  --single-transaction --routines "$MARIADB_DATABASE"' | gzip > pulsewatch-$(date +%F).sql.gz
docker run --rm -v pulsewatch_data:/data -v "$PWD":/backup alpine tar czf /backup/pulsewatch-data-$(date +%F).tgz -C /data .

# Restore into an empty database
docker compose up -d mariadb
gunzip -c pulsewatch-2026-01-01.sql.gz | docker compose exec -T mariadb sh -c 'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"'
docker run --rm -v pulsewatch_data:/data -v "$PWD":/backup alpine tar xzf /backup/pulsewatch-data-2026-01-01.tgz -C /data
docker compose up -d
```

(The volume prefix `pulsewatch_` is the compose project name; check `docker volume ls`.)

The heartbeat table is the largest part. If dumps get big, rely on rollups: lower `PW_RETENTION_RAW_DAYS`. For a quick, key-independent copy of your *configuration* use **Settings > Backup** (YAML/JSON export, secrets masked by default), see [Config as code](#config-as-code).

## Upgrading

```bash
git pull            # or fetch the new release
docker compose build --pull
docker compose up -d
```

Migrations run automatically at startup under a database lock, so several replicas can start at once. They are forward-only: take a database backup first. Check the release notes for new environment variables before upgrading; unknown variables are ignored.

## Importing from Uptime Kuma

In Uptime Kuma 1.x open **Settings > Backup > Export** (JSON). In PulseWatch go to **Settings > Backup**, use the *Import from Uptime Kuma* card, upload the file and run a **dry run** first. The importer converts monitors (including nested groups), tags and notification channels, reports what it skipped (unsupported monitor types are listed as warnings; maintenance windows and status pages are not imported) and merges by name, so it is safe to run twice. Credentials contained in the backup are re-encrypted with your key.

## Config as code

**Settings > Backup** (or `GET /api/config/export?format=yaml|json`) writes monitors, groups, tags, channels, maintenance windows and status pages as one document that references objects by name. Secrets are masked unless you ask for them. **Import** merges by name, supports a dry run and keeps stored secrets when the document contains the mask. This works for GitOps: keep the file in git and apply it with an API token (`POST /api/config/import`).

## Security notes

- Secrets (passwords, tokens, webhook URLs) are encrypted at rest and never returned in clear text by the API.
- Outbound requests go through an SSRF guard that checks addresses after DNS resolution and on redirects. Private ranges are allowed by default because monitoring internal hosts is the main use case; switch to `public-only` or add allow/deny lists in Settings.
- CSRF token per session, strict CSP and security headers, `HttpOnly` + `SameSite` cookies, rate limiting, schema validation on every endpoint, parameterized queries only.
- Docker images run as a non-root user, the compose services run read-only with all capabilities dropped (only `NET_RAW` for ICMP ping).
- Dependencies are pinned to exact versions with a lockfile. `npm audit --omit=dev` reports no known vulnerabilities at the time of writing.
- Report vulnerabilities privately to the maintainers (PD-Codes) instead of opening a public issue.

## Development and tests

```bash
npm ci
# a MariaDB for development and tests
docker run -d --name pw-dev-db -e MARIADB_ROOT_PASSWORD=dev -p 3306:3306 mariadb:11

PW_DB_USER=root PW_DB_PASSWORD=dev npm run dev          # API + scheduler on :3000
PW_DEV_API=http://localhost:3000 npx vite --config web/vite.config.ts   # UI dev server

npm run typecheck && npx tsc -p tsconfig.web.json --noEmit
npm run test:unit            # runners, state machine, telemetry (no database)
npm run test:integration     # real MariaDB, one throwaway database per test file
npm run build && npm run e2e # Playwright against the built server in demo mode
npx tsx test/load/scheduler.ts 2000 30 60   # scheduler load test
```

Test database connection defaults to `root`/`dev` on `127.0.0.1:3306`; override with `PW_TEST_DB_HOST`, `PW_TEST_DB_PORT`, `PW_TEST_DB_USER`, `PW_TEST_DB_PASSWORD`. For e2e on a machine without the Playwright browser cache, set `PW_E2E_CHROMIUM` to a Chromium binary.

## Tested limits

Measured with `test/load/scheduler.ts` on a 2 vCPU / 8 GB virtual machine, MariaDB 11 on the same machine, TCP monitors against a local listener, 75 s runs:

| Monitors | Interval | Checks/s | Achieved vs. ideal | Peak scheduler lag | Peak RSS |
| --- | --- | --- | --- | --- | --- |
| 2,000 | 30 s | 66 | 99 % | 1.1 s | 196 MB |
| 5,000 | 30 s | 164 | 99 % | 1.3 s | 257 MB |

These numbers measure the scheduler, database writes and rollup bookkeeping. Real checks are slower than a loopback TCP connect (HTTP with TLS, DNS) and hold a concurrency slot while they wait, so the practical ceiling depends on your targets' latency: with `PW_MAX_CONCURRENCY=200` and an average check time of 500 ms you can sustain about 400 checks per second. Raise the limit or add `PW_ROLE=worker` containers beyond that. Not tested: multi-day soak runs, more than 5,000 monitors, MariaDB on slow disks.

## Surprise features

- **Anomaly hint:** flags response-time drift against the monitor's own baseline, without any AI service.
- **"What changed?"** (Insights): correlates an incident with other monitors that went down at the same time, in the same group, behind the same dependency or on the same host.
- **Uptime heatmap calendar** (Insights): one square per day, up to a year.
- **Uptime badges:** SVG badges (`/badge/<id>/status.svg`, `uptime-30d.svg`, `ping.svg`) for READMEs, opt-in per monitor.
- **Daily digest:** one summary mail per day (Settings > Daily digest, with preview).
- **Kiosk mode:** `/kiosk` wall display with large tiles that rotates through pages.
- **Command palette and shortcuts:** `Ctrl/Cmd+K` jumps to any monitor or page.
- **Dead-man's switch:** `PW_DEADMAN_URL` makes PulseWatch ping an external service so you notice when PulseWatch itself is down.
- **Saved views and flap detection** on the dashboard and per monitor.

## Known limitations

- OIDC, LDAP and passkeys are covered by code review and unit-level checks only; they have not been tested against live Keycloak/Entra ID/OpenLDAP servers or real authenticators. Try them on a staging instance first.
- Probe-only monitors are evaluated on the monitor's schedule, not at the instant a probe reports.
- Tracing exports one flat span per check (no parent/child context propagation).
- Kuma import targets the 1.x backup format; Kuma 2.x exports are not covered.
- Two status-page widgets are simple by design: components cannot be reordered across sections by drag and drop, and the kiosk page skips paused monitors.
- Only MariaDB 11 is supported (MySQL may work but is not tested).
