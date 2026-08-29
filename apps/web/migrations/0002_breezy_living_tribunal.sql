CREATE TABLE `idempotency_records` (
	`key` text PRIMARY KEY NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`operation` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`revision_sequence` integer NOT NULL,
	`manifest_json` text NOT NULL,
	`lockfile_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_type` text NOT NULL,
	`created_by_id` text NOT NULL,
	`operation_type` text NOT NULL,
	`operation_skill_id` text,
	`operation_metadata_json` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspace_skills` (
	`workspace_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`source` text NOT NULL,
	`skill_name` text NOT NULL,
	`ref` text NOT NULL,
	`targets_json` text NOT NULL,
	`repository` text,
	`locked_revision` text,
	`path` text,
	`content_hash` text,
	`resolution_status` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
