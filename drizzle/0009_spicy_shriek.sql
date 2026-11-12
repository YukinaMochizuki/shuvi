ALTER TABLE `turn_steps` ADD `tokens_before` integer;--> statement-breakpoint
ALTER TABLE `turn_steps` ADD `tokens_after` integer;--> statement-breakpoint
ALTER TABLE `turns` ADD `backend_session_id` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `opening` text;