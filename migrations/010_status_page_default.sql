-- 010_status_page_default: one status page can serve as the home page ("/")
ALTER TABLE status_pages ADD COLUMN is_default TINYINT(1) NOT NULL DEFAULT 0 AFTER history_days;
