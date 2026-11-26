CREATE TABLE `info_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`var_names` text NOT NULL,
	`sealed` blob NOT NULL,
	`changed` text NOT NULL,
	`by` text NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `secret_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `info_versions_profile` ON `info_versions` (`profile_id`,`id`);--> statement-breakpoint
DROP INDEX `secret_profiles_name_unique`;--> statement-breakpoint
ALTER TABLE `secret_profiles` ADD `kind` text DEFAULT 'secret' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `secret_profiles_kind_name` ON `secret_profiles` (`kind`,`name`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_secret_notes` (
	`kind` text DEFAULT 'secret' NOT NULL,
	`name` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`kind`, `name`)
);
--> statement-breakpoint
INSERT INTO `__new_secret_notes`("kind", "name", "summary", "details", "updated_by", "updated_at") SELECT 'secret', "name", "summary", "details", "updated_by", "updated_at" FROM `secret_notes`;--> statement-breakpoint
DROP TABLE `secret_notes`;--> statement-breakpoint
ALTER TABLE `__new_secret_notes` RENAME TO `secret_notes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;