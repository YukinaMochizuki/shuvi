CREATE TABLE `chat_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`tg_update_id` integer,
	`tg_message_id` integer,
	`idem_key` text,
	`status` text,
	`note` text,
	`turn_id` integer,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_events_tg_update_id_unique` ON `chat_events` (`tg_update_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_events_idem_key_unique` ON `chat_events` (`idem_key`);--> statement-breakpoint
CREATE INDEX `chat_events_chat_seq` ON `chat_events` (`chat_id`,`seq`);--> statement-breakpoint
CREATE INDEX `chat_events_status` ON `chat_events` (`status`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tg_chat_id` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`cursor_seq` integer DEFAULT 0 NOT NULL,
	`backend_session_id` text,
	`context_tokens` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chats_tg_chat_id_unique` ON `chats` (`tg_chat_id`);--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`status` text NOT NULL,
	`pid` integer,
	`from_seq` integer NOT NULL,
	`to_seq` integer NOT NULL,
	`error` text,
	`cost_micro_usd` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turns_one_running_per_chat` ON `turns` (`chat_id`) WHERE status = 'running';