CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`origin_seq` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`report` text NOT NULL,
	`spec` text NOT NULL,
	`token_hash` text,
	`result` text,
	`deadline` text NOT NULL,
	`next_poll_at` text,
	`note` text,
	`owner_authorised` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_state` ON `jobs` (`state`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`note` text NOT NULL,
	`at` text,
	`cron` text,
	`time_zone` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`next_at` text,
	`last_fired_at` text,
	`created_turn_id` integer,
	`owner_authorised` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `schedules_due` ON `schedules` (`state`,`next_at`);