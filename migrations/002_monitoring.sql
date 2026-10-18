-- 002_monitoring: groups, tags, monitors, state, heartbeats (partitioned), rollups, events, probes
CREATE TABLE monitor_groups (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  parent_id INT UNSIGNED NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  sort INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_groups_parent (parent_id),
  CONSTRAINT fk_groups_parent FOREIGN KEY (parent_id) REFERENCES monitor_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE permission_grants (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  resource_type ENUM('monitor_group','status_page') NOT NULL,
  resource_id INT UNSIGNED NOT NULL,
  level ENUM('view','manage') NOT NULL DEFAULT 'view',
  UNIQUE KEY uq_grants (user_id, resource_type, resource_id),
  CONSTRAINT fk_grants_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE probes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  location VARCHAR(128) NULL,
  token_hash CHAR(64) NOT NULL,
  version VARCHAR(32) NULL,
  last_seen_at DATETIME(3) NULL,
  last_ip VARCHAR(64) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_probes_name (name),
  UNIQUE KEY uq_probes_token (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tags (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  color VARCHAR(16) NOT NULL DEFAULT '#6366f1',
  UNIQUE KEY uq_tags_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE monitors (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(32) NOT NULL,
  group_id INT UNSIGNED NULL,
  description TEXT NULL,
  config LONGTEXT NOT NULL,
  interval_s INT UNSIGNED NOT NULL DEFAULT 60,
  timeout_s INT UNSIGNED NOT NULL DEFAULT 10,
  retries TINYINT UNSIGNED NOT NULL DEFAULT 0,
  retry_interval_s INT UNSIGNED NOT NULL DEFAULT 20,
  up_threshold TINYINT UNSIGNED NOT NULL DEFAULT 1,
  down_threshold TINYINT UNSIGNED NOT NULL DEFAULT 1,
  flap_window TINYINT UNSIGNED NOT NULL DEFAULT 10,
  flap_threshold TINYINT UNSIGNED NOT NULL DEFAULT 6,
  active TINYINT(1) NOT NULL DEFAULT 1,
  locations TEXT NULL,
  quorum TINYINT UNSIGNED NOT NULL DEFAULT 1,
  push_token CHAR(32) NULL,
  public_badge TINYINT(1) NOT NULL DEFAULT 0,
  next_run_at DATETIME(3) NULL,
  lease_owner VARCHAR(64) NULL,
  lease_until DATETIME(3) NULL,
  attempt TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_by INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_monitors_push (push_token),
  KEY idx_monitors_due (active, next_run_at),
  KEY idx_monitors_group (group_id),
  CONSTRAINT fk_monitors_group FOREIGN KEY (group_id) REFERENCES monitor_groups(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE monitor_tags (
  monitor_id INT UNSIGNED NOT NULL,
  tag_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (monitor_id, tag_id),
  KEY idx_monitor_tags_tag (tag_id),
  CONSTRAINT fk_mt_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE,
  CONSTRAINT fk_mt_tag FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE monitor_dependencies (
  monitor_id INT UNSIGNED NOT NULL,
  depends_on_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (monitor_id, depends_on_id),
  KEY idx_dep_parent (depends_on_id),
  CONSTRAINT fk_dep_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE,
  CONSTRAINT fk_dep_parent FOREIGN KEY (depends_on_id) REFERENCES monitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE monitor_state (
  monitor_id INT UNSIGNED NOT NULL PRIMARY KEY,
  status ENUM('unknown','up','down','pending') NOT NULL DEFAULT 'unknown',
  overlay ENUM('none','maintenance','suppressed') NOT NULL DEFAULT 'none',
  status_since DATETIME(3) NULL,
  consecutive_fail INT UNSIGNED NOT NULL DEFAULT 0,
  consecutive_ok INT UNSIGNED NOT NULL DEFAULT 0,
  last_check_at DATETIME(3) NULL,
  last_latency_ms INT NULL,
  last_error_kind VARCHAR(32) NULL,
  last_message VARCHAR(512) NULL,
  flapping TINYINT(1) NOT NULL DEFAULT 0,
  outcomes VARCHAR(64) NOT NULL DEFAULT '',
  recent LONGTEXT NULL,
  cert_expires_at DATETIME(3) NULL,
  cert_info LONGTEXT NULL,
  anomaly TEXT NULL,
  last_push_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_state_updated (updated_at),
  CONSTRAINT fk_state_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE monitor_location_state (
  monitor_id INT UNSIGNED NOT NULL,
  location_id INT UNSIGNED NOT NULL,
  ok TINYINT(1) NOT NULL,
  ts DATETIME(3) NOT NULL,
  latency_ms INT NULL,
  error_kind VARCHAR(32) NULL,
  message VARCHAR(512) NULL,
  PRIMARY KEY (monitor_id, location_id),
  CONSTRAINT fk_mls_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Raw check results. Partitioned daily by ts (no foreign keys allowed on partitioned tables).
-- status: 0 down, 1 up, 2 pending (failed attempt, retry scheduled), 3 maintenance, 4 suppressed
-- location_id: 0 = the server itself, otherwise probes.id
CREATE TABLE heartbeats (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  monitor_id INT UNSIGNED NOT NULL,
  location_id INT UNSIGNED NOT NULL DEFAULT 0,
  ts DATETIME(3) NOT NULL,
  status TINYINT UNSIGNED NOT NULL,
  latency_ms INT NULL,
  error_kind VARCHAR(32) NULL,
  message VARCHAR(512) NULL,
  PRIMARY KEY (id, ts),
  KEY idx_hb_monitor_ts (monitor_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
PARTITION BY RANGE (TO_DAYS(ts)) (PARTITION p_future VALUES LESS THAN MAXVALUE);

CREATE TABLE rollups (
  monitor_id INT UNSIGNED NOT NULL,
  res ENUM('minute','hour','day') NOT NULL,
  bucket DATETIME NOT NULL,
  total INT UNSIGNED NOT NULL,
  up_n INT UNSIGNED NOT NULL,
  down_n INT UNSIGNED NOT NULL,
  maint_n INT UNSIGNED NOT NULL DEFAULT 0,
  lat_n INT UNSIGNED NOT NULL DEFAULT 0,
  lat_sum BIGINT UNSIGNED NOT NULL DEFAULT 0,
  lat_min INT UNSIGNED NULL,
  lat_max INT UNSIGNED NULL,
  lat_p50 INT UNSIGNED NULL,
  lat_p95 INT UNSIGNED NULL,
  lat_p99 INT UNSIGNED NULL,
  PRIMARY KEY (monitor_id, res, bucket),
  KEY idx_rollups_bucket (res, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  monitor_id INT UNSIGNED NULL,
  ts DATETIME(3) NOT NULL,
  type VARCHAR(32) NOT NULL,
  from_status VARCHAR(16) NULL,
  to_status VARCHAR(16) NULL,
  error_kind VARCHAR(32) NULL,
  message VARCHAR(1024) NULL,
  details LONGTEXT NULL,
  KEY idx_events_monitor_ts (monitor_id, ts),
  KEY idx_events_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE saved_views (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  filters TEXT NOT NULL,
  shared TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_views_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
