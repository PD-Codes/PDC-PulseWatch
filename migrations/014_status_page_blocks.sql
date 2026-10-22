-- 014_status_page_blocks: optional content blocks below the component list of a status page (uptime summary, heatmap, days without incident, free text).
-- JSON array, validated by the application; NULL = none.
ALTER TABLE status_pages ADD COLUMN blocks TEXT NULL AFTER custom_css;
