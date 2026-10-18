-- 004_status_pages
CREATE TABLE status_pages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  domain VARCHAR(255) NULL,
  is_public TINYINT(1) NOT NULL DEFAULT 1,
  password_hash VARCHAR(255) NULL,
  sso_required TINYINT(1) NOT NULL DEFAULT 0,
  branding TEXT NULL,
  custom_css MEDIUMTEXT NULL,
  show_history TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_status_slug (slug),
  UNIQUE KEY uq_status_domain (domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE status_page_sections (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  page_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  sort INT NOT NULL DEFAULT 0,
  KEY idx_sps_page (page_id),
  CONSTRAINT fk_sps_page FOREIGN KEY (page_id) REFERENCES status_pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE status_page_components (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  page_id INT UNSIGNED NOT NULL,
  section_id INT UNSIGNED NULL,
  monitor_id INT UNSIGNED NOT NULL,
  display_name VARCHAR(255) NULL,
  sort INT NOT NULL DEFAULT 0,
  KEY idx_spc_page (page_id),
  CONSTRAINT fk_spc_page FOREIGN KEY (page_id) REFERENCES status_pages(id) ON DELETE CASCADE,
  CONSTRAINT fk_spc_section FOREIGN KEY (section_id) REFERENCES status_page_sections(id) ON DELETE SET NULL,
  CONSTRAINT fk_spc_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE status_page_announcements (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  page_id INT UNSIGNED NOT NULL,
  kind ENUM('info','maintenance','incident') NOT NULL DEFAULT 'info',
  title VARCHAR(255) NOT NULL,
  body TEXT NULL,
  starts_at DATETIME(3) NOT NULL,
  ends_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_spa_page (page_id, starts_at),
  CONSTRAINT fk_spa_page FOREIGN KEY (page_id) REFERENCES status_pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE status_page_subscribers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  page_id INT UNSIGNED NOT NULL,
  kind ENUM('email','webhook') NOT NULL,
  target_enc TEXT NOT NULL,
  target_hash CHAR(64) NOT NULL,
  token CHAR(32) NOT NULL,
  verified TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sub_target (page_id, target_hash),
  UNIQUE KEY uq_sub_token (token),
  CONSTRAINT fk_sub_page FOREIGN KEY (page_id) REFERENCES status_pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
