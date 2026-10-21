-- 012_tag_values: a tag can be attached to a monitor plainly (value '') or as name + value (Uptime Kuma style).
-- One ALTER keeps the foreign key on monitor_id backed by an index while the primary key is swapped.
ALTER TABLE monitor_tags
  ADD COLUMN value VARCHAR(255) NOT NULL DEFAULT '' AFTER tag_id,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (monitor_id, tag_id, value);
