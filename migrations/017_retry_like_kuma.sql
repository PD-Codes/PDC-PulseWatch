-- Retries work like Uptime Kuma: every failure (timeout, not reachable, wrong status, ...) is retried, so the per-kind list from 016 is not needed.
ALTER TABLE monitors DROP COLUMN retry_on;
