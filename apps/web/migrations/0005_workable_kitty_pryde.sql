CREATE TABLE `cli_pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`user_id` text,
	`device_id` text,
	`device_name` text NOT NULL,
	`platform` text NOT NULL,
	`architecture` text NOT NULL,
	`cli_version` text NOT NULL,
	`expires_at` integer NOT NULL,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cli_pairings_status_check" CHECK("cli_pairings"."status" IN ('PENDING', 'APPROVED', 'EXPIRED', 'CONSUMED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cli_pairings_device_code_hash_unique` ON `cli_pairings` (`device_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `cli_pairings_user_code_unique` ON `cli_pairings` (`user_code`);