CREATE TABLE `secret_notes` (
	`name` text PRIMARY KEY NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secret_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`var_names` text NOT NULL,
	`sealed` blob NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_profiles_name_unique` ON `secret_profiles` (`name`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_secret_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer,
	`profile` text NOT NULL,
	`approval_id` integer,
	`expires_at` text,
	`revoke_approval_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_secret_grants`("id", "chat_id", "profile", "approval_id", "expires_at", "revoke_approval_id", "created_at") SELECT "id", "chat_id", "profile", "approval_id", "expires_at", "revoke_approval_id", "created_at" FROM `secret_grants`;--> statement-breakpoint
DROP TABLE `secret_grants`;--> statement-breakpoint
ALTER TABLE `__new_secret_grants` RENAME TO `secret_grants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `secret_grants_approval_id_unique` ON `secret_grants` (`approval_id`);--> statement-breakpoint
CREATE INDEX `secret_grants_chat` ON `secret_grants` (`chat_id`);