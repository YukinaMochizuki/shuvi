CREATE TABLE `deleted_turn_steps` (
	`id` integer PRIMARY KEY NOT NULL,
	`deletion_id` integer NOT NULL,
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
	`tokens_before` integer,
	`tokens_after` integer,
	`at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`deletion_id`) REFERENCES `deletions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deleted_turn_steps_deletion` ON `deleted_turn_steps` (`deletion_id`);--> statement-breakpoint
CREATE TABLE `deleted_turn_transcripts` (
	`turn_id` integer PRIMARY KEY NOT NULL,
	`deletion_id` integer NOT NULL,
	`prompt_hash` text,
	`input` text NOT NULL,
	`model` text,
	`resumed` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`deletion_id`) REFERENCES `deletions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deleted_turn_transcripts_deletion` ON `deleted_turn_transcripts` (`deletion_id`);--> statement-breakpoint
CREATE TABLE `deleted_turns` (
	`id` integer PRIMARY KEY NOT NULL,
	`deletion_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`status` text NOT NULL,
	`pid` integer,
	`pid_start` text,
	`term_at` text,
	`from_seq` integer NOT NULL,
	`to_seq` integer NOT NULL,
	`trigger_seq` integer,
	`stop_seq` integer,
	`error` text,
	`cost_micro_usd` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_creation_tokens` integer,
	`backend_session_id` text,
	`opening` text,
	`conversation_start` text,
	`profile` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`deletion_id`) REFERENCES `deletions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deleted_turns_deletion` ON `deleted_turns` (`deletion_id`);--> statement-breakpoint
CREATE TABLE `spent_idem_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`spent_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `deleted_events` ADD `by_turn` integer;