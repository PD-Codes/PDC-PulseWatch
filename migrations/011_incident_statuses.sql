-- 011_incident_statuses: investigation phases between "acknowledged" and "resolved"; every timeline entry remembers the status it set.
ALTER TABLE incidents MODIFY status ENUM('open','acknowledged','identified','fixing','monitoring','resolved') NOT NULL DEFAULT 'open';
ALTER TABLE incident_updates ADD COLUMN status ENUM('open','acknowledged','identified','fixing','monitoring','resolved') NULL AFTER kind;
