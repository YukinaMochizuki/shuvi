CREATE TABLE `approvals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`options` text NOT NULL,
	`origin_chat_id` integer,
	`data` text,
	`status` text NOT NULL,
	`answer` text,
	`answered_at` text,
	`expires_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`origin_chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `control_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`idem_key` text,
	`topic` text,
	`approval_id` integer,
	`status` text NOT NULL,
	`tg_message_id` integer,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_messages_idem_key_unique` ON `control_messages` (`idem_key`);--> statement-breakpoint
CREATE INDEX `control_messages_status` ON `control_messages` (`status`);--> statement-breakpoint
CREATE INDEX `control_messages_topic` ON `control_messages` (`topic`,`created_at`);--> statement-breakpoint
ALTER TABLE `turns` ADD `pid_start` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `term_at` text;