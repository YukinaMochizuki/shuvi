ALTER TABLE `approvals` ADD `requested_by` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `authorised_by` integer;--> statement-breakpoint
ALTER TABLE `schedules` ADD `authorised_by` integer;