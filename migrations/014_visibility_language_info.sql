-- One visibility switch per incident ("show on status pages") instead of public + hidden, and one per timeline entry.
-- Before: manual incidents were shown when public = 1, automatic ones always, and hidden overrode both.
UPDATE incidents SET public = CASE WHEN hidden = 1 THEN 0 WHEN source = 'auto' THEN 1 ELSE public END;
ALTER TABLE incidents DROP COLUMN hidden;

-- Entries that were shown before stay shown; plain notes are internal unless someone marks them. edited_at marks a changed entry.
ALTER TABLE incident_updates ADD COLUMN public TINYINT(1) NOT NULL DEFAULT 0 AFTER body, ADD COLUMN edited_at DATETIME(3) NULL AFTER public;
UPDATE incident_updates SET public = 1 WHERE kind IN ('status', 'resolve', 'postmortem');

-- Status pages: fixed language (NULL = visitor decides) and how much game server detail visitors see (0 none, 1 players and version, 2 also player names).
ALTER TABLE status_pages ADD COLUMN language VARCHAR(5) NULL AFTER description, ADD COLUMN server_info TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER incident_page_size;

-- Latest game server details of a monitor (players online, version, ...), cleared while the check fails.
ALTER TABLE monitor_state ADD COLUMN info TEXT NULL AFTER anomaly;
