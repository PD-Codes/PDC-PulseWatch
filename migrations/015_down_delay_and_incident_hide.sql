-- 015_down_delay_and_incident_hide
-- down_after_s: report a monitor as down only after it has been failing this long; NULL follows the instance-wide rule (Settings > Defaults).
ALTER TABLE monitors ADD COLUMN down_after_s INT UNSIGNED NULL AFTER flap_threshold;
-- fail_since: start of the current failure streak, used by the delay above.
ALTER TABLE monitor_state ADD COLUMN fail_since DATETIME(3) NULL AFTER consecutive_ok;
-- hide_incidents: keep this component's resolved incidents out of the "past incidents" list of that status page.
ALTER TABLE status_page_components ADD COLUMN hide_incidents TINYINT(1) NOT NULL DEFAULT 0 AFTER display_name;
