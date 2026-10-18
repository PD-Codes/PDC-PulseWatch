-- 003_incidents_maintenance
CREATE TABLE incidents (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  status ENUM('open','acknowledged','resolved') NOT NULL DEFAULT 'open',
  severity ENUM('minor','major','critical') NOT NULL DEFAULT 'major',
  source ENUM('auto','manual') NOT NULL DEFAULT 'auto',
  monitor_id INT UNSIGNED NULL,
  started_at DATETIME(3) NOT NULL,
  acknowledged_at DATETIME(3) NULL,
  acknowledged_by INT UNSIGNED NULL,
  resolved_at DATETIME(3) NULL,
  assignee_id INT UNSIGNED NULL,
  postmortem MEDIUMTEXT NULL,
  public TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_incidents_status (status, started_at),
  KEY idx_incidents_monitor (monitor_id, started_at),
  KEY idx_incidents_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE incident_monitors (
  incident_id INT UNSIGNED NOT NULL,
  monitor_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (incident_id, monitor_id),
  KEY idx_im_monitor (monitor_id),
  CONSTRAINT fk_im_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
  CONSTRAINT fk_im_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE incident_updates (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  incident_id INT UNSIGNED NOT NULL,
  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  user_id INT UNSIGNED NULL,
  kind ENUM('note','status','ack','assign','resolve','auto','postmortem') NOT NULL DEFAULT 'note',
  body TEXT NULL,
  KEY idx_iu_incident (incident_id, ts),
  CONSTRAINT fk_iu_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE maintenance_windows (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  kind ENUM('once','cron') NOT NULL DEFAULT 'once',
  starts_at DATETIME(3) NULL,
  ends_at DATETIME(3) NULL,
  cron_expr VARCHAR(64) NULL,
  duration_min INT UNSIGNED NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  active TINYINT(1) NOT NULL DEFAULT 1,
  announce TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE maintenance_targets (
  window_id INT UNSIGNED NOT NULL,
  target_type ENUM('monitor','group','tag') NOT NULL,
  target_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (window_id, target_type, target_id),
  CONSTRAINT fk_mtg_window FOREIGN KEY (window_id) REFERENCES maintenance_windows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
