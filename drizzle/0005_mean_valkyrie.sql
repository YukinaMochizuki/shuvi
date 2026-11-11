CREATE TABLE `sticker_library` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file` text NOT NULL,
	`pack` text NOT NULL,
	`n` integer NOT NULL,
	`file_unique_id` text NOT NULL,
	`desc` text DEFAULT '' NOT NULL,
	`use` text DEFAULT '' NOT NULL,
	`tier` text NOT NULL,
	`dm_only` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sticker_library_pack_n` ON `sticker_library` (`pack`,`n`);--> statement-breakpoint
CREATE INDEX `sticker_library_file` ON `sticker_library` (`file`);--> statement-breakpoint
CREATE TABLE `sticker_meta` (
	`file_unique_id` text PRIMARY KEY NOT NULL,
	`set_name` text NOT NULL,
	`position` integer NOT NULL,
	`file_id` text NOT NULL,
	`emoji` text,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`format` text NOT NULL,
	`narrow` integer NOT NULL,
	`path` text,
	`mime_type` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sticker_meta_set` ON `sticker_meta` (`set_name`,`position`);--> statement-breakpoint
CREATE TABLE `sticker_packs` (
	`file` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`pack` text,
	`role` text,
	`dm_only` integer DEFAULT false NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `sticker_sets` (
	`name` text PRIMARY KEY NOT NULL,
	`title` text,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`count` integer,
	`requested_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`fetched_at` text
);
