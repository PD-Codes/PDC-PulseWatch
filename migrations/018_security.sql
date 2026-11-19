-- Failed credential checks per (scope, subject, client): progressive delays per client instead of one lock that anybody could trigger for an account,
-- plus an account-wide counter (client '') against distributed guessing. Scopes: login (subject u:<username>), reauth (u:<user id>), status (p:<page id>).
CREATE TABLE IF NOT EXISTS auth_failures (
  scope VARCHAR(16) NOT NULL,
  subject VARCHAR(191) NOT NULL,
  client VARCHAR(80) NOT NULL,
  failures INT UNSIGNED NOT NULL DEFAULT 0,
  first_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_until DATETIME(3) NULL,
  PRIMARY KEY (scope, subject, client),
  KEY ix_auth_failures_last (last_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Last accepted TOTP time step, so a code cannot be used twice.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NULL;
