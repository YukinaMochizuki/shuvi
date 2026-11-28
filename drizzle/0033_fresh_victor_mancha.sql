ALTER TABLE `chats` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `deleted_turns` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `deleted_turns` ADD `effort_source` text;--> statement-breakpoint
ALTER TABLE `models` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `models` ADD `effort_levels` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `effort_source` text;