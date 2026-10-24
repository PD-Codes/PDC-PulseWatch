-- Incident texts (and announcements) in two languages: the title and the timeline messages carry an optional English and German version next to the
-- text the author wrote (NULL = show that text in every language). Subscribers remember the language they signed up in.
ALTER TABLE incidents ADD COLUMN title_en VARCHAR(255) NULL AFTER title, ADD COLUMN title_de VARCHAR(255) NULL AFTER title_en;
ALTER TABLE incident_updates ADD COLUMN body_en TEXT NULL AFTER body, ADD COLUMN body_de TEXT NULL AFTER body_en;
ALTER TABLE status_page_subscribers ADD COLUMN lang VARCHAR(5) NULL AFTER verified;
ALTER TABLE status_page_announcements ADD COLUMN title_en VARCHAR(255) NULL AFTER title, ADD COLUMN title_de VARCHAR(255) NULL AFTER title_en,
  ADD COLUMN body_en TEXT NULL AFTER body, ADD COLUMN body_de TEXT NULL AFTER body_en;
