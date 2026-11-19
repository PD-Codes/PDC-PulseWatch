-- Alert snooze, SLO targets and themes. Every statement is idempotent, so a run that was interrupted can simply be repeated
-- (see migrations/README.md).

-- Notifications of a monitor are held back until this instant; runtime state, not part of the configuration export.
ALTER TABLE monitor_state ADD COLUMN IF NOT EXISTS snoozed_until DATETIME(3) NULL;
-- The job that ends snoozes looks for the ones that ran out.
ALTER TABLE monitor_state ADD INDEX IF NOT EXISTS idx_state_snoozed (snoozed_until);

-- Availability target over a rolling 30-day window, in percent (50 <= x < 100, three decimals); NULL means no target.
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS slo_target DECIMAL(6,3) NULL;
-- 1 while the 30-day uptime is below the target and the breach has been announced; reset once it is back above (with hysteresis).
ALTER TABLE monitor_state ADD COLUMN IF NOT EXISTS slo_breached TINYINT(1) NOT NULL DEFAULT 0;

-- Personal color theme of the web interface (NULL: the instance default). users.theme keeps the light/dark mode.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_theme VARCHAR(32) NULL;
-- Color theme of a public status page (NULL: the instance default).
ALTER TABLE status_pages ADD COLUMN IF NOT EXISTS theme VARCHAR(32) NULL;
