CREATE TABLE `device_skill_updates` (
	`device_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`status` text NOT NULL,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "device_skill_updates_status_check" CHECK("device_skill_updates"."status" IN ('UP_TO_DATE', 'UPDATE_AVAILABLE', 'UNKNOWN', 'AUTH_REQUIRED', 'CHECK_FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_skill_updates_unique` ON `device_skill_updates` (`device_id`,`workspace_id`,`skill_id`);