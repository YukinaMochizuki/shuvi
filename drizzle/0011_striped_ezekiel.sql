CREATE TABLE `conversation_messages` (
	`conversation_id` text NOT NULL,
	`generation` integer NOT NULL,
	`seq` integer NOT NULL,
	`message` text NOT NULL,
	PRIMARY KEY(`conversation_id`, `generation`, `seq`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` integer NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`written_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversations_written_at` ON `conversations` (`written_at`);