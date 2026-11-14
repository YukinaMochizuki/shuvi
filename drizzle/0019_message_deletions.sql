CREATE TABLE `deleted_events` (
	`seq` integer PRIMARY KEY NOT NULL,
	`deletion_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`tg_update_id` integer,
	`tg_message_id` integer,
	`idem_key` text,
	`status` text,
	`note` text,
	`turn_id` integer,
	`at` text NOT NULL,
	FOREIGN KEY (`deletion_id`) REFERENCES `deletions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deleted_events_deletion` ON `deleted_events` (`deletion_id`);--> statement-breakpoint
CREATE TABLE `deletion_scrubs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deletion_id` integer NOT NULL,
	`target` text NOT NULL,
	`ref` integer NOT NULL,
	`original` text NOT NULL,
	`scrubbed` text NOT NULL,
	FOREIGN KEY (`deletion_id`) REFERENCES `deletions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deletion_scrubs_deletion` ON `deletion_scrubs` (`deletion_id`);--> statement-breakpoint
CREATE TABLE `deletions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`purge_at` text NOT NULL,
	`cursor_seq` integer NOT NULL,
	`last_turn_id` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
