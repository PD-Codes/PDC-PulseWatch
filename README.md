# PulseWatch

Self-hosted uptime and status monitoring. Think Uptime Kuma, but built on MariaDB, with multi-location probes, roles and permissions, SSO, long-term rollups and a modern UI.

Copyright (c) PD-Codes. Licensed under [GPL-3.0-only](LICENSE). No telemetry, no phone-home.

- [Quick start](#quick-start)
- [Features](#features)
- [Configuration reference](#configuration-reference)
- [Architecture](#architecture)
- [Probes (multi-location checks)](#probes-multi-location-checks)
- [Working with many monitors](#working-with-many-monitors)
- [Status page history and groups](#status-page-history-and-groups)
- [Certificates and TLS errors](#certificates-and-tls-errors)
- [Single sign-on with SAML (Entra ID)](#single-sign-on-with-saml-entra-id)
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

**Monitoring:** HTTP(S) with method/headers/body/auth/status codes/redirects/TLS toggle, keyword and JSON path checks, multi-step HTTP flows, TCP, ICMP ping, UDP, DNS, TLS certificate expiry (with chain), domain/WHOIS expiry, SMTP, IMAP/POP3, SSH banner, SFTP (password or key login, optional pinned host key, file or directory presence, minimum size and maximum age), WebSocket, gRPC, MQTT, SNMP, NTP (clock offset), RADIUS, LDAP, FTP/FTPS, RDP, SIP, RabbitMQ, Kafka, MariaDB/MySQL, PostgreSQL, MSSQL, Oracle, Redis, MongoDB, Docker container state, PM2 processes, Globalping (ping/HTTP from a chosen country or city), game servers (Minecraft, Steam/Source, about 350 more through GameDig, Pelican/Pterodactyl panels, CubeCoders AMP) and push/heartbeat and manual-status monitors. Every monitor has interval, timeout, retries, up/down thresholds, flap detection, tags, groups, pause/clone/bulk edit and notification rules. Failure modes (DNS, refused, timeout, TLS, wrong status, ...) are distinct error kinds in the event log.

**Operations:** nested groups with dependencies (children are suppressed while a parent is down), automatic and manual incidents with six statuses (open, acknowledged, identified, being fixed, monitoring, resolved), groups as incident scope, assignee, notes, post-mortem and MTTR/MTTA, maintenance windows (once or cron, timezone-aware), status pages (custom domain, branding, custom CSS, password or login protection, email/RSS/webhook subscriptions).

**Notifications:** email, Telegram, Discord, Slack, Microsoft Teams, ntfy, Gotify, Pushover and templated webhooks (plus a plugin hook, `registerChannelType`). Templates, escalation policies, quiet hours, per-channel test button and a delivery log with retry.

**Security and users:** local accounts, OIDC (Entra ID, Keycloak, Google, ...), SAML 2.0 (Entra ID), LDAP, TOTP, passkeys (WebAuthn), API tokens with scopes, session management, audit log, roles plus per-group and per-status-page permissions.

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

The compose file passes all `PW_RETENTION_*` variables through. `PW_IMAGE`, `PW_PROBE_IMAGE`, `PW_PUBLIC_PORT` (host port, default 3000) and `PW_DB_BUFFER_POOL` (MariaDB InnoDB buffer pool, default 256M) only affect the compose file.

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

## Working with many monitors

- **Dashboard:** a click anywhere on a card or row opens the monitor. The pause/resume button on each card acts at once (and rolls back if the server refuses). *Select* shows checkboxes, *Select all shown* picks everything the current filter lists.
- **Bulk add:** on *New monitor* switch on *Add several monitors at once*, then paste one target per line (`name | address`, `name; address`, a tab-separated pair from a spreadsheet, or just the address). A live preview marks duplicate names; everything else on the form is shared. Lines that fail validation stay in the box so you can fix and resend them.
- **Bulk edit:** timings, thresholds, flapping, group, public badge, tags (add/remove) and notification rules (add or replace) for all selected monitors. Fields left on *keep* are not touched.
- **Tags:** two kinds. *Simple tags* are just a name (click to attach). *Tags with a value* have a name and a value (`env: production`, the model Uptime Kuma uses); both fields are dropdowns that end with *Add new...*, which opens a small dialog. A monitor can carry the same name with several values. Chips show `name: value`, the dashboard search finds values, *Groups & tags* lists the values in use with their counts, and export/import and the Kuma import keep them (`tags: [simple, {name: env, value: production}]` in YAML/JSON).
- **Recent checks filter:** the *Recent checks* card on a monitor has a status dropdown with multiple selection. It lists only the statuses that monitor has produced lately (up, down, pending, maintenance, suppressed) and filters all pages, not just the visible one.
- **Latency statistics:** the chart and the report use plain names with a tooltip: *Typical (p50)* is the median, *Slow (p95)* means 19 of 20 checks were faster, *Worst case (p99)* means 99 of 100 were faster.
- **Defaults:** *Settings > Defaults* sets the timings and thresholds that pre-fill new monitors and apply when an API call or import omits them. Existing monitors are not changed.
- **Inline group:** the folder button next to *Group* creates a (sub)group without leaving the form.
- **Incident badge:** the menu shows the number of open incidents nobody has acknowledged; the same number prefixes the browser tab title. The top bar has a **+** button for a new monitor.

## Home page and sign-in

Mark a status page as *home page* (status page list, *Use as home page*) and it is served at `/` for everyone. The admin UI stays reachable at `/dashboard` and `/admin`, which ask for a login. Without a home page `/` goes to the dashboard as before. Only one page can be the home page; setting another one moves the mark. A page that is not public is never used.

## Incidents

An incident moves through *open*, *acknowledged*, *identified*, *being fixed*, *monitoring* and *resolved*; any status can follow any other one, and reopening clears the end time. In the incident dialog you can pick a whole monitor group instead of ticking every monitor. Notes you add are internal. Only status changes, the resolution and the post-mortem appear on the public status page, so write those for customers. Auto-resolve (the monitor recovered) leaves an incident in *monitoring* alone until someone resolves it; if the monitor fails again while monitoring, the incident reopens.

## Restricting sign-in to groups

Each OIDC, SAML and LDAP provider has an allow-list (**Allowed groups**; for LDAP **Allowed group DNs**, one per line). Members of an allowed group, of the admin groups or of the editor groups can sign in. Everyone else gets no account or session and is sent to the first public status page (no password, no sign-in requirement) or sees a notice that they lack permission. An empty list restricts nobody. The switch **Editors and admins only** goes further: only members of the admin or editor groups get in, plain viewers are refused (needs those groups to be set; no effect when the default role is Editor). Refusals are audited as `login.denied`, and a user who loses the group has their sessions ended at the next sign-in attempt.

## Report as down after (restarts and flapping)

A monitor can be told to open an incident and alert only after it has been failing for a while (seconds or minutes), so restarts and short blips are ignored; a recovery inside the window never opens an incident. Set it per monitor (**Report as down after**) or instance-wide under **Settings > Defaults**; an empty monitor field follows the instance rule, and the instance rule applies live. While the window runs the monitor is re-checked at its retry interval.

On a status page, the eye icon of a component hides that component's resolved incidents from the "past incidents" list (and the RSS feed). Open incidents stay visible.

## Status page extras

The **Extras** tab of a status page adds blocks below the components: an uptime summary (24 h, 7, 30, 90 days), a daily heatmap (90, 180 or 365 days), days without an incident and free text blocks. Figures only cover the page's own components and are cached for 60 seconds.

## HTTP(S) JSON monitors

In the monitor form, **Fetch result** calls the URL once with the form's settings (same SSRF rules, masked secrets restored from the saved monitor) and shows the response as a tree. Click a value to fill path, comparison and expected value.

## Status page history and groups

In the status page editor an announcement is one click away: pick *Info*, *Maintenance* or *Incident* (a notice with an optional start and end). *Subscribers* (mail subscriptions) only appears when SMTP is configured. The same rule hides every other function that sends mail (daily digest, scheduled reports) while `PW_SMTP_HOST` is empty.

Each status page has its own history length (14, 30, 60, 90, 120, 150 or 180 days, default 90). In the editor, *Add a whole group* adds a monitor group, optionally with its subgroups, as sections; monitors already on the page are skipped.

The *Address (slug)* of a new status page follows the title as you type (`Public Services` becomes `public-services`, umlauts become `ae`, `oe`, `ue`, `ss`) until you edit it by hand; clearing the field makes it follow the title again.

**Past incidents:** the public page lists resolved incidents of the last 1, 3, 7, 14, 30 (default), 60, 90, 180 or 365 days, or none at all (switch *Show past incidents* off). Ongoing incidents always show. Long lists are paged (5, 10, 20 or 50 per page, default 10); visitors can change the page size themselves. The RSS feed follows the same age limit. A single incident can be taken off every status page and feed without deleting it: use the eye button in *Incidents* or the *Hide from status pages* switch on the incident (hidden ones carry a *Hidden* badge). The settings are part of the configuration export and import.

## Certificates and TLS errors

*Settings > Certificates* imports private CA certificates (PEM, paste or file). They are trusted in addition to the built-in roots by HTTP, TLS, SMTP, MQTT, database, WebSocket and gRPC checks, on the server and on remote probes (probes receive them with their job list). Expired and duplicate certificates are skipped and reported. Processes reload the store every 30 seconds.

TLS failures now name what happened: expiry date and days, subject, issuer, host:port, SNI and the Node error code, for example `TLS certificate expired on 2026-01-02 (12 days ago): CN=..., issuer CN=..., host a.example.com:443 (CERT_HAS_EXPIRED)`. The same text appears in heartbeats, logs, down mails and the daily digest, which also lists each failing monitor with its target.

## Single sign-on with SAML (Entra ID)

1. In Entra ID create an *Enterprise application* (non-gallery), open *Single sign-on > SAML*.
2. In PulseWatch go to *Settings > Authentication*, add a provider of type *SAML 2.0* and save it. The dialog then shows the three values for Entra: *Identifier (entity ID)*, *Reply URL (ACS)* and the metadata URL. Enter identifier and reply URL in Entra.
3. Copy *Login URL*, *Microsoft Entra Identifier* and the Base64 signing certificate from Entra into the provider and save. Assertions must be signed; unsigned ones are rejected.
4. Optional: map the groups claim (object IDs) to roles like for OIDC.

Login is service-provider initiated only. The short-lived state cookie is `SameSite=None; Secure`, so the base URL must be https (or localhost); behind a proxy without https the login fails with `state_expired`.

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

**Kuma 2.x has no backup export, so two other sources are supported** (**Settings > Backup > Import from Uptime Kuma 1.x / 2.x**):

- **Database file:** upload `data/kuma.db` (SQLite, Kuma 1.x or 2.x). It is streamed to `PW_DATA_DIR/import-tmp`, opened read-only and deleted right after; only the configuration tables are read, so a multi-gigabyte heartbeat history is fine. Copy the file while Kuma is stopped (or together with its `-wal` file).
- **Live API:** enter the URL, username and password of a running Kuma (and the two-factor code if the account has one). PulseWatch logs in over Kuma's Socket.IO API once, reads the lists Kuma pushes and logs out; the login is not stored. A Kuma that runs on MariaDB can only be imported this way.

Both show a **preview** (what would be created or updated, plus warnings) and write nothing until you press apply; the preview is kept in memory for 15 minutes. The import runs as a background job with a progress bar, so a large Kuma 2.x no longer blocks the page. The URL may carry a trailing slash or a page such as `/dashboard`; PulseWatch cuts it down to the base address.

**What gets imported:** groups, tags (with values), notification channels (email, Telegram, Discord, Slack, Teams, ntfy, Gotify, Pushover, webhook), monitors (including the protocols PulseWatch has runners for: NTP, RADIUS, RabbitMQ, Kafka, Steam, GameDig, manual, PM2, Oracle, Globalping, SFTP, SMTP, SNMP, ...; Docker hosts become the monitor's endpoint), **maintenance windows** (single, daily, weekly, monthly and cron ones, targets are the linked monitors) and **status pages** (sections, monitors, custom domain, title, description, the pinned incident as an announcement; the Kuma entry page becomes the home page). Kuma's server time zone becomes the default for maintenance windows, and its certificate-expiry days become the warning threshold of the imported monitors. In the preview each section has a master checkbox and per-item checkboxes, so you can import only the status pages or only some monitors, and rows where something changes on the way (for example "upside down mode is not supported") carry a note.

**What cannot be imported** is listed in its own section of the preview, with a reason per row, a copy button and a CSV download: Tailscale ping and unknown monitor types, notification types without an equivalent, manual and rarely repeating maintenance windows, settings that are environment variables here (data retention, trust proxy, base URL, ...), proxies, API keys and remote browsers. Secrets such as Kuma's JWT secret are never read. Existing items with the same name or slug are updated, nothing else is touched, so running it twice is safe.

For a Kuma 1.x backup JSON use the second card on the same page: The importer converts monitors (including nested groups), tags and notification channels, reports what it skipped (unsupported monitor types are listed as warnings) and merges by name. Credentials contained in the backup are re-encrypted with your key.

## Tested limits

Measured with `test/load/scheduler.ts` on a 2 vCPU / 8 GB virtual machine, MariaDB 11 on the same machine, TCP monitors against a local listener, 75 s runs:

| Monitors | Interval | Checks/s | Achieved vs. ideal | Peak scheduler lag | Peak RSS | App CPU (share of one core) |
| --- | --- | --- | --- | --- | --- | --- |
| 2,000 | 30 s | 66 | 99 % | 1.3 s | 199 MB | 9 % (7.1 s CPU in 75 s) |
| 5,000 | 30 s | 165 | 99 % | 1.1 s | 264 MB | 15 % (11.5 s CPU in 75 s) |

"Achieved vs. ideal" is the number of checks that ran divided by the number the intervals call for (the run is cut off after 75 s, so a few checks of the last interval are not counted). CPU is the PulseWatch process only, MariaDB comes on top. These numbers measure the scheduler, database writes and rollup bookkeeping. Real checks are slower than a loopback TCP connect (HTTP with TLS, DNS) and hold a concurrency slot while they wait, so the practical ceiling depends on your targets' latency: with `PW_MAX_CONCURRENCY=200` and an average check time of 500 ms you can sustain about 400 checks per second. Raise the limit or add `PW_ROLE=worker` containers beyond that. Not tested: multi-day soak runs, more than 5,000 monitors, MariaDB on slow disks.

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
- **Bulk-add preview:** pasted spreadsheet columns are parsed live, duplicates are flagged before anything is created, failed lines stay in the box.
- **Days without an incident** and a heatmap as optional status page blocks.
- **JSON suggestions:** *Fetch result* proposes checks for typical status fields (`status`, `healthy`, `ok`, ...).
- **Open-incident count in the tab title,** so a background tab shows `(2) Dashboard`.
- **Whole-group import for status pages,** including subgroups.

## Known limitations

- SAML is verified with locally signed assertions (valid and tampered, wrong audience, replay, unsolicited), not against a real Entra ID tenant. IdP-initiated login, metadata-URL import and group overage (more than 150 groups) are not supported.
- Custom CAs are tested with HTTP and TLS checks against a local server; the database, gRPC and MongoDB drivers only compile with the option. The CA list is re-parsed per connection (`shortcut:` in `src/core/trust.ts`).
- OIDC, LDAP and passkeys are covered by code review and unit-level checks only; they have not been tested against live Keycloak/Entra ID/OpenLDAP servers or real authenticators. Try them on a staging instance first.
- Probe-only monitors are evaluated on the monitor's schedule, not at the instant a probe reports.
- Tracing exports one flat span per check (no parent/child context propagation).
- The Kuma 2.x import (database file and API) is covered by tests with a generated SQLite file and a fake Socket.IO server that follows Kuma's protocol as documented, not by a real Kuma 2.x instance. Kuma column names and units for the newer monitor types, maintenance strategies and settings are written from the documented schema, not checked against a real instance. Check history, proxies, API keys, remote browsers and Tailscale ping monitors are not imported.
- The newer monitor types are tested against fake servers that follow the protocols as documented, not against the real products: NTP, RADIUS, FTP, RDP, SIP, LDAP, Kafka, RabbitMQ, Steam/A2S, GameDig (through a Source query), Pelican, AMP and Globalping. Pelican and AMP use their documented HTTP APIs (AMP instance states are taken from its public enum). Oracle is only tested against a closed port and has no TLS (TCPS) support. Kafka is a broker check (metadata and topic leaders, no SASL, no message is produced). PM2 needs the `pm2` command on the machine that runs the check, which the container image does not have: use a probe on the PM2 host. There is no real-browser monitor.
- Two status-page widgets are simple by design: components cannot be reordered across sections by drag and drop, and the kiosk page skips paused monitors.
- Only MariaDB 11 is supported (MySQL may work but is not tested).
