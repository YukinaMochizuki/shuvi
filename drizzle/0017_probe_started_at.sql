ALTER TABLE `models` ADD `probe_started_at` text;--> statement-breakpoint
-- A probe asked or running was `probe_status = 'checking'`; it is now `probe_started_at` set, and `probe_status` keeps
-- only a finished probe's result. The old rows lost theirs when they were marked, so they have none.
UPDATE `models` SET `probe_started_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now'), `probe_status` = NULL WHERE `probe_status` = 'checking';
