ALTER TABLE `chat_events` ADD `sent_at` text;--> statement-breakpoint
ALTER TABLE `deleted_events` ADD `sent_at` text;--> statement-breakpoint
ALTER TABLE `deleted_turns` ADD `timings` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `timings` text;