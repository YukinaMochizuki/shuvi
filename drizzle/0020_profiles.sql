DROP INDEX `sticker_library_file`;--> statement-breakpoint
DROP INDEX `sticker_library_pack_n`;--> statement-breakpoint
CREATE UNIQUE INDEX `sticker_library_file_n` ON `sticker_library` (`file`,`n`);--> statement-breakpoint
CREATE INDEX `sticker_library_pack_n` ON `sticker_library` (`pack`,`n`);--> statement-breakpoint
ALTER TABLE `chats` ADD `profile` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `profile` text;