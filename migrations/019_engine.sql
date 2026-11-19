-- Monitoring engine robustness. Every statement is idempotent, so a run that was interrupted can simply be repeated.

-- A long "report as down after" with a short retry interval needs more than 255 attempts (TINYINT made every round fail in strict mode).
ALTER TABLE monitors MODIFY COLUMN attempt SMALLINT UNSIGNED NOT NULL DEFAULT 0;

-- Interval the current schedule was planned with; a different value (bulk edit, import) spreads the next round over the new interval.
ALTER TABLE monitor_state ADD COLUMN IF NOT EXISTS sched_interval_s INT UNSIGNED NULL;

-- Side effects of a state change (incident, escalation, notifications) are written in the same transaction as the state itself
-- and processed after the commit; a periodic sweep picks up what a crashed or stuck process left behind.
CREATE TABLE IF NOT EXISTS engine_outbox (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  monitor_id INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  payload MEDIUMTEXT NOT NULL,
  status ENUM('pending','done','failed') NOT NULL DEFAULT 'pending',
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  claimed_by VARCHAR(64) NULL,
  claimed_until DATETIME(3) NULL,
  incident_done TINYINT(1) NOT NULL DEFAULT 0,
  incident_ids VARCHAR(255) NULL,
  done_at DATETIME(3) NULL,
  last_error VARCHAR(1000) NULL,
  KEY idx_outbox_due (status, next_attempt_at),
  KEY idx_outbox_monitor (monitor_id, status, id),
  KEY idx_outbox_done (done_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Monitors whose maintenance start has been announced; the row is the compare-and-set that keeps start/end events unique
-- when several processes (api + worker, several workers) watch the same windows.
CREATE TABLE IF NOT EXISTS maintenance_marks (
  monitor_id INT UNSIGNED NOT NULL PRIMARY KEY,
  since DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- DOWN/UP go out in order per channel and monitor; this finds the head (oldest pending) of every chain from the pending rows
-- alone, without reading the delivery history.
CREATE INDEX IF NOT EXISTS idx_nd_chain ON notification_deliveries (status, monitor_id, channel_id, event, id);
