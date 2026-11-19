-- Data handling for large installations. Every statement is idempotent, so a run that was interrupted can simply be repeated
-- (see migrations/README.md).

-- The minute rollup reads the server's own heartbeats (location 0) of the last few minutes every 30 s. Without this index it
-- scanned the whole daily partition. Built online: inserts keep running while the index is created.
ALTER TABLE heartbeats ADD INDEX IF NOT EXISTS idx_hb_location_ts (location_id, ts), ALGORITHM=INPLACE, LOCK=NONE;

-- Result ids already accepted from a remote probe, so a batch that is sent again after a lost response is stored only once.
-- Rows are kept for two days by the retention job.
CREATE TABLE IF NOT EXISTS probe_results_seen (
  probe_id INT UNSIGNED NOT NULL,
  result_id VARCHAR(64) NOT NULL,
  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (probe_id, result_id),
  KEY idx_prs_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
