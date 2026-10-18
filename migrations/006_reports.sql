-- 006_reports: scheduled SLA reports
CREATE TABLE report_schedules (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  scope_type ENUM('all','group','monitor','tag') NOT NULL DEFAULT 'all',
  scope_id INT UNSIGNED NULL,
  range_days INT UNSIGNED NOT NULL DEFAULT 30,
  cron_expr VARCHAR(64) NOT NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  recipients TEXT NOT NULL,
  format ENUM('pdf','csv') NOT NULL DEFAULT 'pdf',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_run_at DATETIME(3) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
