-- 005_notifications
CREATE TABLE notification_templates (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_tpl_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notification_channels (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  type VARCHAR(32) NOT NULL,
  config_enc LONGTEXT NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  quiet_hours TEXT NULL,
  template_id INT UNSIGNED NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_channels_name (name),
  CONSTRAINT fk_channels_tpl FOREIGN KEY (template_id) REFERENCES notification_templates(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE escalation_policies (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  steps TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_policies_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE monitor_notifications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  monitor_id INT UNSIGNED NOT NULL,
  channel_id INT UNSIGNED NULL,
  policy_id INT UNSIGNED NULL,
  events VARCHAR(128) NOT NULL DEFAULT 'down,up',
  KEY idx_mn_monitor (monitor_id),
  CONSTRAINT fk_mn_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE,
  CONSTRAINT fk_mn_channel FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON DELETE CASCADE,
  CONSTRAINT fk_mn_policy FOREIGN KEY (policy_id) REFERENCES escalation_policies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notification_deliveries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  channel_id INT UNSIGNED NULL,
  monitor_id INT UNSIGNED NULL,
  incident_id INT UNSIGNED NULL,
  event VARCHAR(32) NOT NULL,
  status ENUM('pending','sent','failed','skipped') NOT NULL DEFAULT 'pending',
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NULL,
  last_error VARCHAR(1024) NULL,
  subject VARCHAR(255) NULL,
  payload LONGTEXT NULL,
  KEY idx_nd_pending (status, next_attempt_at),
  KEY idx_nd_ts (ts),
  KEY idx_nd_monitor (monitor_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE escalation_runs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  incident_id INT UNSIGNED NOT NULL,
  monitor_id INT UNSIGNED NOT NULL,
  policy_id INT UNSIGNED NOT NULL,
  next_step INT UNSIGNED NOT NULL DEFAULT 0,
  next_at DATETIME(3) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  KEY idx_er_due (active, next_at),
  KEY idx_er_incident (incident_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
