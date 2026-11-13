CREATE TABLE `chat_lanes` (
	`chat_id` integer NOT NULL,
	`lane` text NOT NULL,
	`backend_session_id` text NOT NULL,
	`context_tokens` integer,
	`parked_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`chat_id`, `lane`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `model_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config_dir` text,
	`base_url` text,
	`api_key` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_providers_name_unique` ON `model_providers` (`name`);--> statement-breakpoint
CREATE TABLE `model_switches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`from_model` text,
	`to_model` text NOT NULL,
	`mode` text NOT NULL,
	`from_session_id` text,
	`to_session_id` text,
	`carried` integer DEFAULT 0 NOT NULL,
	`compacted` integer DEFAULT false NOT NULL,
	`turn_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `model_switches_chat` ON `model_switches` (`chat_id`,`id`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`model` text NOT NULL,
	`label` text,
	`context_window` integer,
	`vision` integer DEFAULT false NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `model_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_provider_model` ON `models` (`provider_id`,`model`);--> statement-breakpoint
CREATE UNIQUE INDEX `models_one_default` ON `models` (`is_default`) WHERE is_default = 1;--> statement-breakpoint
ALTER TABLE `chats` ADD `model` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `lane` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `lane_entered_at` text;