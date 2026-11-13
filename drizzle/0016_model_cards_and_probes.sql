CREATE TABLE `control_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`chat_id` integer,
	`idem_key` text,
	`state` text NOT NULL,
	`text` text NOT NULL,
	`keyboard` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`rev` integer DEFAULT 0 NOT NULL,
	`switch_request_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_cards_idem_key_unique` ON `control_cards` (`idem_key`);--> statement-breakpoint
ALTER TABLE `control_messages` ADD `card_id` integer;--> statement-breakpoint
ALTER TABLE `models` ADD `vision_set` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `probe_status` text;--> statement-breakpoint
ALTER TABLE `models` ADD `probe_error` text;--> statement-breakpoint
ALTER TABLE `models` ADD `probe_latency_ms` integer;--> statement-breakpoint
ALTER TABLE `models` ADD `probed_at` text;--> statement-breakpoint
ALTER TABLE `models` ADD `probe_vision` integer;