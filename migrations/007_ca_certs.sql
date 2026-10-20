-- 007_ca_certs: extra CA certificates trusted by every TLS check
CREATE TABLE ca_certs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  pem TEXT NOT NULL,
  subject VARCHAR(512) NOT NULL,
  issuer VARCHAR(512) NOT NULL,
  fingerprint256 CHAR(95) NOT NULL,
  valid_from DATETIME(3) NOT NULL,
  valid_to DATETIME(3) NOT NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ca_fp (fingerprint256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
