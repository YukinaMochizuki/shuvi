CREATE TABLE `warm_runners` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`pid` integer NOT NULL,
	`pid_start` text,
	`fingerprint` text NOT NULL,
	`code_version` text NOT NULL,
	`idle_since` text NOT NULL,
	`cli_started_at` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `deleted_turns` ADD `handoff` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `handoff` text;