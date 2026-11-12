CREATE TABLE `media_prewarms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`n` integer NOT NULL,
	`url_hash` text NOT NULL,
	`host` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`outcome` text,
	`result` text,
	`used_turn_id` integer,
	`used_at` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_prewarms_seq_n` ON `media_prewarms` (`seq`,`n`);--> statement-breakpoint
CREATE INDEX `media_prewarms_hash` ON `media_prewarms` (`chat_id`,`url_hash`);