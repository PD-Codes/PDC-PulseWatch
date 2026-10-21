-- 013_incident_display: per status page, how many days of resolved incidents are listed (0 = none) and how many per page;
-- per incident, a flag that removes it from every status page and feed without deleting its history.
ALTER TABLE status_pages
  ADD COLUMN incident_days SMALLINT UNSIGNED NOT NULL DEFAULT 30 AFTER is_default,
  ADD COLUMN incident_page_size TINYINT UNSIGNED NOT NULL DEFAULT 10 AFTER incident_days;
-- pages without history used to list a week of incidents
UPDATE status_pages SET incident_days = 7 WHERE show_history = 0;
ALTER TABLE incidents ADD COLUMN hidden TINYINT(1) NOT NULL DEFAULT 0 AFTER public;
