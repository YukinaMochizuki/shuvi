CREATE TABLE `computers` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`disk` text NOT NULL,
	`container` text NOT NULL,
	`created` integer DEFAULT false NOT NULL,
	`run_state` text DEFAULT 'stopped' NOT NULL,
	`boost` text,
	`op` text,
	`op_until` text,
	`leases` text DEFAULT '{}' NOT NULL,
	`last_exec_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `secret_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`profile` text NOT NULL,
	`approval_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`revoke_approval_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_grants_approval_id_unique` ON `secret_grants` (`approval_id`);--> statement-breakpoint
CREATE INDEX `secret_grants_chat` ON `secret_grants` (`chat_id`);--> statement-breakpoint
CREATE INDEX `chat_events_attachment_pending` ON `chat_events` (`seq`) WHERE json_extract(payload, '$.attachment.fileId') IS NOT NULL AND coalesce(json_extract(payload, '$.attachment.state'), 'new') IN ('new', 'requested');