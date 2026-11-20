-- Wall display (kiosk) presets and read-only kiosk keys. Every statement is idempotent, so a run that was interrupted can simply be
-- repeated (see migrations/README.md).

-- A named wall display setup, called with /kiosk?preset=<slug>. `config` holds only the settings that differ from the defaults
-- (src/core/kiosk.ts), so later changes of a default reach old presets. An empty name means: the app shows a translated name.
CREATE TABLE IF NOT EXISTS kiosk_presets (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL DEFAULT '',
  config TEXT NOT NULL,
  sort INT NOT NULL DEFAULT 0,
  created_by INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_kiosk_presets_slug (slug),
  CONSTRAINT fk_kiosk_presets_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Read-only access to one preset without a login (wall displays). Only the SHA-256 of the key is stored; the prefix lets admins
-- tell keys apart. Deleting the preset revokes its keys.
CREATE TABLE IF NOT EXISTS kiosk_keys (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  preset_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_prefix VARCHAR(16) NOT NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3) NULL,
  last_ip VARCHAR(64) NULL,
  UNIQUE KEY uq_kiosk_keys_hash (token_hash),
  KEY idx_kiosk_keys_preset (preset_id),
  CONSTRAINT fk_kiosk_keys_preset FOREIGN KEY (preset_id) REFERENCES kiosk_presets(id) ON DELETE CASCADE,
  CONSTRAINT fk_kiosk_keys_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The presets every installation starts with (BUILTIN_SLUGS). INSERT IGNORE leaves existing rows alone when the file runs again.
INSERT IGNORE INTO kiosk_presets (slug, name, config, sort) VALUES
  ('all', '', '{"display":"cards"}', 10),
  ('wall', '', '{"display":"wall","grouped":true}', 20),
  ('groups', '', '{"display":"groups"}', 30),
  ('problems', '', '{"show":"problems"}', 40),
  ('history', '', '{"display":"heatmap"}', 50);
