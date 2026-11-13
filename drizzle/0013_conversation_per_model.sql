CREATE TABLE `chat_conversations` (
	`chat_id` integer NOT NULL,
	`model` text NOT NULL,
	`backend_session_id` text NOT NULL,
	`context_tokens` integer,
	`parked_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`chat_id`, `model`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `model_switch_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`to_model` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`stopped_turn_id` integer,
	`result` text,
	`error` text,
	`requested_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`done_at` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `model_switch_requests_pending` ON `model_switch_requests` (`chat_id`,`id`) WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE `chats` ADD `conversation_model` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `entered_at` text;--> statement-breakpoint
-- A conversation per model (agent/switch.ts). Each conversation a chat has, the active one (`chats.lane`, or
-- before lanes the seeded Claude login's) and each parked in `chat_lanes`, is given the model it belongs to.
-- A PARKED one, the first of:
--   1. the model of the most recent `model_switches` row that entered (`to_session_id`) or left
--      (`from_session_id`) it, that session id exactly;
--   2. the chat's own model, if in that lane; 3. the default, if in that lane;
--   4. the first model of that lane's provider(s).
-- The ACTIVE one: 2, then 3, then 1, then 4. It is the conversation the chat runs on now, and a change of the
-- default within a lane wrote no switch row, so the model the chat runs on is the better witness: a switch row
-- could name a model the chat has since left, and the first turn would move the live conversation away.
-- A parked one that maps to nothing is dropped (its history ages out). So is an active one, except while the
-- catalog is still empty (a store from before the catalog, which the server seeds after migrating): that one
-- stays with no model and the next turn gives it one (switch.ts `activeModel`). A chat left with no active
-- conversation takes its model's parked one at its next turn (switch.ts `enterChatModel`). 0014 then drops the
-- lanes.
CREATE TABLE `__conversation_models` (`chat_id` integer NOT NULL, `lane` text NOT NULL, `session` text, `active` integer NOT NULL, `model` text);--> statement-breakpoint
INSERT INTO `__conversation_models` (`chat_id`, `lane`, `session`, `active`)
  SELECT `chat_id`, `lane`, `backend_session_id`, 0 FROM `chat_lanes`;--> statement-breakpoint
INSERT INTO `__conversation_models` (`chat_id`, `lane`, `session`, `active`)
  SELECT `id`, `lane`, `session`, 1 FROM (
    SELECT c.`id`, c.`backend_session_id` AS `session`, coalesce(
      c.`lane`,
      CASE WHEN c.`backend_session_id` IS NOT NULL THEN coalesce(
        (SELECT CASE p.`kind` WHEN 'claude' THEN 'claude:' || p.`name` ELSE 'openai-compat' END FROM `model_providers` p WHERE p.`name` = 'claude'),
        (SELECT 'claude:' || p.`name` FROM `model_providers` p WHERE p.`kind` = 'claude' ORDER BY p.`id` LIMIT 1)
      ) END
    ) AS `lane`
    FROM `chats` c
  ) WHERE `lane` IS NOT NULL;--> statement-breakpoint
UPDATE `__conversation_models` SET `model` = coalesce(
  (SELECT c.`model` FROM `chats` c WHERE c.`id` = `__conversation_models`.`chat_id` AND c.`model` IS NOT NULL AND EXISTS (
    SELECT 1 FROM `model_providers` p WHERE substr(c.`model`, 1, length(p.`name`) + 1) = p.`name` || '/'
      AND (CASE p.`kind` WHEN 'claude' THEN 'claude:' || p.`name` ELSE 'openai-compat' END) = `__conversation_models`.`lane`)),
  (SELECT p.`name` || '/' || m.`model` FROM `models` m JOIN `model_providers` p ON p.`id` = m.`provider_id`
    WHERE m.`is_default` = 1 AND (CASE p.`kind` WHEN 'claude' THEN 'claude:' || p.`name` ELSE 'openai-compat' END) = `__conversation_models`.`lane`)
) WHERE `active` = 1;--> statement-breakpoint
UPDATE `__conversation_models` SET `model` = (
  SELECT CASE WHEN s.`to_session_id` = `__conversation_models`.`session` THEN s.`to_model` ELSE s.`from_model` END
  FROM `model_switches` s
  WHERE s.`chat_id` = `__conversation_models`.`chat_id`
    AND (s.`to_session_id` = `__conversation_models`.`session` OR (s.`from_session_id` = `__conversation_models`.`session` AND s.`from_model` IS NOT NULL))
  ORDER BY s.`id` DESC LIMIT 1
) WHERE `model` IS NULL AND `session` IS NOT NULL;--> statement-breakpoint
UPDATE `__conversation_models` SET `model` = coalesce(
  (SELECT c.`model` FROM `chats` c WHERE c.`id` = `__conversation_models`.`chat_id` AND c.`model` IS NOT NULL AND EXISTS (
    SELECT 1 FROM `model_providers` p WHERE substr(c.`model`, 1, length(p.`name`) + 1) = p.`name` || '/'
      AND (CASE p.`kind` WHEN 'claude' THEN 'claude:' || p.`name` ELSE 'openai-compat' END) = `__conversation_models`.`lane`)),
  (SELECT p.`name` || '/' || m.`model` FROM `models` m JOIN `model_providers` p ON p.`id` = m.`provider_id`
    WHERE m.`is_default` = 1 AND (CASE p.`kind` WHEN 'claude' THEN 'claude:' || p.`name` ELSE 'openai-compat' END) = `__conversation_models`.`lane`),
  (SELECT p.`name` || '/' || m.`model` FROM `models` m JOIN `model_providers` p ON p.`id` = m.`provider_id`
    WHERE (CASE p.`kind` WHEN 'claude' THEN 'claude:' || p.`name` ELSE 'openai-compat' END) = `__conversation_models`.`lane` ORDER BY p.`id`, m.`id` LIMIT 1)
) WHERE `model` IS NULL;--> statement-breakpoint
UPDATE `chats` SET
  `conversation_model` = (SELECT m.`model` FROM `__conversation_models` m WHERE m.`chat_id` = `chats`.`id` AND m.`active` = 1),
  `entered_at` = `lane_entered_at`;--> statement-breakpoint
UPDATE `chats` SET `backend_session_id` = NULL, `entered_at` = NULL, `context_tokens` = NULL
  WHERE `backend_session_id` IS NOT NULL AND `conversation_model` IS NULL AND EXISTS (SELECT 1 FROM `models`);--> statement-breakpoint
INSERT OR IGNORE INTO `chat_conversations` (`chat_id`, `model`, `backend_session_id`, `context_tokens`, `parked_at`)
  SELECT m.`chat_id`, m.`model`, l.`backend_session_id`, l.`context_tokens`, l.`parked_at`
  FROM `__conversation_models` m
  JOIN `chat_lanes` l ON l.`chat_id` = m.`chat_id` AND l.`lane` = m.`lane`
  JOIN `chats` c ON c.`id` = m.`chat_id`
  WHERE m.`active` = 0 AND m.`model` IS NOT NULL AND m.`model` IS NOT c.`conversation_model`
  ORDER BY l.`parked_at` DESC;--> statement-breakpoint
DROP TABLE `__conversation_models`;
