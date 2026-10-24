-- One retry setting instead of two counters: "report as down after X retries" replaces retries x failure threshold, and retry_on says
-- which kinds of failure are retried at all. A monitor that needed `threshold` failed rounds of `retries` retries each used to take
-- threshold * (retries + 1) failed checks in a row to go down; that is exactly retries' = threshold * (retries + 1) - 1 retries now.
ALTER TABLE monitors ADD COLUMN retry_on VARCHAR(40) NOT NULL DEFAULT 'timeout,unreachable,other' AFTER retries;
UPDATE monitors SET retries = LEAST(100, down_threshold * (retries + 1) - 1);
ALTER TABLE monitors DROP COLUMN down_threshold;
