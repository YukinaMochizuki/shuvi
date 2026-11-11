CREATE TABLE `prompt_texts` (
	`hash` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`sections` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turn_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` integer NOT NULL,
	`n` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`sent` integer,
	`outbound_seq` integer,
	`name` text,
	`args` text,
	`result` text,
	`status` text,
	`error` text,
	`call_id` text,
	`images` text,
	`from_seq` integer,
	`to_seq` integer,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_steps_turn_n` ON `turn_steps` (`turn_id`,`n`);--> statement-breakpoint
CREATE INDEX `turn_steps_name` ON `turn_steps` (`name`,`turn_id`);--> statement-breakpoint
CREATE TABLE `turn_transcripts` (
	`turn_id` integer PRIMARY KEY NOT NULL,
	`prompt_hash` text,
	`input` text NOT NULL,
	`model` text,
	`resumed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prompt_hash`) REFERENCES `prompt_texts`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `turns` ADD `cache_creation_tokens` integer;--> statement-breakpoint
CREATE INDEX `turns_chat_id` ON `turns` (`chat_id`,`id`);--> statement-breakpoint
CREATE INDEX `chat_events_turn` ON `chat_events` (`turn_id`);