# Changelog

All notable changes to PulseWatch are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-11-19

### Security

- Creating the first administrator needs a setup token: `PW_SETUP_TOKEN`, or a one-time token that is generated on the first start and written to the log. Whoever reaches a fresh installation first can no longer claim it.
- `PW_TRUST_PROXY` accepts `false`, `true`, a number of proxy hops or comma separated proxy IPs/CIDRs. `true` keeps the old behavior but logs a warning at start, because clients can then forge `X-Forwarded-For`. Invalid values stop the start. `PW_SSRF_MODE` is validated at start as well (`allow-private` or `public-only`).
- Creating an API token and exporting the configuration with secrets ask for the password again (and the authenticator code when two-factor authentication is on). `GET /api/config/export?secrets=true` is refused; use `POST /api/config/export`.
- Changing your own password revokes all of your API tokens.
- The failed-attempt lock works per account and client address (plus an account-wide limit) and now also covers LDAP sign-in and status page passwords. Authenticator codes cannot be reused.
- Stored secrets are only reused when the target of a monitor or channel is unchanged, so changing a URL or host cannot send an existing secret to a new destination. When a request is redirected to another origin, the monitor's own headers are dropped.
- `/api/docs` and `/api/openapi.json` are only served to signed-in users.
- The SSRF block list now also contains `100.100.100.200` (Alibaba Cloud), `169.254.170.2` (AWS ECS task metadata) and `168.63.129.16` (Azure WireServer).
- Push and subscription tokens are masked in the request log.
- The container starts Node with `--enable-experimental-regexp-engine-on-excessive-backtracks`, so a regular expression with catastrophic backtracking cannot freeze a check.
- README: new *Security notes*. Note that editors can make PulseWatch fetch internal URLs (a JSON check returns up to 1 MB of the response), send raw TCP payloads and run Redis commands: give the editor role only to people you trust.
- Dependencies updated (patch and minor releases, `oracledb` 26.0.0); `npm audit` reports no vulnerabilities.

### Fixed

- Push monitors count uptime by time again instead of by number of heartbeats.
- Checks spread over the whole interval after a restart instead of all running at once.
- Notifications go through an outbox and are not lost when the process crashes. Down and up notifications arrive in the right order.
- Maintenance windows start and end to the second.
- Dependencies also suppress notifications while the parent is `pending`.
- Shutdown is orderly: running checks finish, leases are released, then HTTP and the database close (`PW_SHUTDOWN_GRACE_MS`).
- Partition maintenance has a lock timeout and no longer blocks behind a running database dump. Retention deletes in batches.
- Probe results are corrected for the probe's clock offset and de-duplicated.
- Database migrations run statement by statement; a failure names the file and the statement and says how to repair it.

### Added

- Ten themes: Classic, Dark, Smooth, Monochrome, Nord, Cyberpunk, Sci-Fi, LCARS, Terminal and High contrast. Everyone chooses per device, *Settings* holds the instance default, the kiosk takes `?theme=<id>` and each status page can have its own theme.
- Snooze: silence alerts for 1 hour, 4 hours or until tomorrow on a monitor or an incident. Also available as a bulk action. When a snooze ends and the monitor is still down, one reminder goes out.
- SLO target per monitor with the remaining error budget and a notification when the target is missed (sent to notification rules with the new event "SLO target" and, so nobody misses it, to rules with "Down").
- CSV export of heartbeats and events in the monitor detail.
- Browser notifications (with an optional sound) for outages while a tab is open.
- Pagination with 20 rows per page in all lists.
- A hint when a newer version is available.
- `PW_TIMEZONE` (IANA time zone, default `UTC`): day boundaries of daily rollups, the heatmap, day bars and reports.
- `PW_SETUP_TOKEN`, `PW_SHUTDOWN_GRACE_MS` (default `20000`) and, in the compose file, `PW_BIND` (default `0.0.0.0`).
- Official images on ghcr.io for amd64 and arm64: `ghcr.io/pd-codes/pdc-pulsewatch` (app) and `ghcr.io/pd-codes/pdc-pulsewatch-probe` (probe).
- `docker-compose.build.yml` to build the images from a checkout.
- README sections *Config as code*, *Security notes* and *Development and tests*.

### Changed

- Runtime is Node.js 26 (`engines` `>=26`, `node:26-alpine` images). Node starts with `UV_THREADPOOL_SIZE=64` in the images, because DNS lookups run on the libuv thread pool and the default of 4 is too small for 200 parallel checks.
- `docker-compose.yml` pulls `ghcr.io/pd-codes/pdc-pulsewatch:latest` and `ghcr.io/pd-codes/pdc-pulsewatch-probe:latest` by default (override with `PW_IMAGE` and `PW_PROBE_IMAGE`) instead of building. `docker compose up -d --build` builds only with `-f docker-compose.yml -f docker-compose.build.yml`. The containers get 30 s to stop.
- Docker builds are multi-arch efficient: build and dependency stages always run on the build machine, only the small runtime stage is built for the target platform. `.dockerignore` also excludes `test`, `e2e`, `.github` and `_to_delete`.
- The release workflow runs the integration tests against a MariaDB service container before publishing, builds `linux/amd64` and `linux/arm64`, also publishes the probe image, uses the matching section of this file as release notes and pins all actions to commit SHAs.

### Upgrade notes

- **New index on `heartbeats`.** The first start after the update creates an index for the rollup queries. It is built online (checks keep inserting), but on a large table the first start takes noticeably longer: roughly a million rows per second on an SSD (2,000 monitors at 20 s and 14 days of raw data are about 120 million rows, so 2 to 3 minutes; slow disks or a cold buffer pool can take 10 to 20 minutes). Follow it with `docker compose logs -f app` and do not restart meanwhile. A second process (split worker) waits for the migration instead of giving up, and the image's health check allows 10 minutes for the start.
- **Setup token.** Installations that already have users are not affected. A new, empty installation needs `PW_SETUP_TOKEN` or the token from the log to create the first administrator.
- **Image names.** The compose defaults changed from `pulsewatch/app:latest` and `pulsewatch/probe:latest` to the ghcr.io images above. Update with `docker compose pull && docker compose up -d`. If you build from source, add `-f docker-compose.build.yml` (the images are then tagged `pulsewatch-local/app` and `pulsewatch-local/probe`). A probe started with `docker run` should use `ghcr.io/pd-codes/pdc-pulsewatch-probe:latest`.
- **Node 26.** The images contain it; only people who run PulseWatch outside Docker or develop it need Node 26.
- **Reverse proxy.** If you run with `PW_TRUST_PROXY=true`, switch to the number of proxies in front of the app (for example `1`) or their addresses; `true` still works but logs a warning. Behind a proxy on the same host set `PW_BIND=127.0.0.1`. `PW_TRUST_PROXY=1` used to mean "true" and now means exactly one proxy hop; that is the same for a single proxy, but a chain of proxies needs its real length.
- **Time zone.** Without `PW_TIMEZONE` days stay on UTC and nothing changes. Setting it makes the next start rebuild the daily rollups from the hourly ones.
- **Automation using the API.** Exporting the configuration with secrets and creating API tokens now need the password in the request body (see `/api/docs`). Changing a password revokes the user's API tokens.
