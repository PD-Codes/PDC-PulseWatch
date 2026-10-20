-- Number of days shown in the uptime history bars of a status page.
ALTER TABLE status_pages ADD COLUMN history_days SMALLINT UNSIGNED NOT NULL DEFAULT 90 AFTER show_history;
