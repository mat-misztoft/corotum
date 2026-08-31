CREATE TABLE `workspace_artifacts` (
	`workspace_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`integrity_hash` text NOT NULL,
	`kind` text NOT NULL,
	`content_hash` text NOT NULL,
	`locator` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_artifacts_workspace_skill_integrity_unique` ON `workspace_artifacts` (`workspace_id`,`skill_id`,`integrity_hash`);--> statement-breakpoint
CREATE TABLE `workspace_revision_artifacts` (
	`revision_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`integrity_hash` text NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `workspace_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_revision_artifacts_unique` ON `workspace_revision_artifacts` (`revision_id`,`skill_id`,`integrity_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_revision_artifacts_lookup_unique` ON `workspace_revision_artifacts` (`workspace_id`,`revision_id`,`skill_id`,`integrity_hash`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspace_skills` (
	`workspace_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`source` text,
	`skill_name` text NOT NULL,
	`ref` text,
	`targets_json` text NOT NULL,
	`repository` text,
	`locked_revision` text,
	`path` text,
	`content_hash` text,
	`resolution_status` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_workspace_skills`("workspace_id", "skill_id", "source", "skill_name", "ref", "targets_json", "repository", "locked_revision", "path", "content_hash", "resolution_status", "updated_at") SELECT "workspace_id", "skill_id", "source", "skill_name", "ref", "targets_json", "repository", "locked_revision", "path", "content_hash", "resolution_status", "updated_at" FROM `workspace_skills`;--> statement-breakpoint
DROP TABLE `workspace_skills`;--> statement-breakpoint
ALTER TABLE `__new_workspace_skills` RENAME TO `workspace_skills`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_skills_workspace_skill_unique` ON `workspace_skills` (`workspace_id`,`skill_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_skills_workspace_normalized_name_unique` ON `workspace_skills` (`workspace_id`,lower(`skill_name`));--> statement-breakpoint
ALTER TABLE `workspace_revisions` ADD `disposition_ledger_json` text NOT NULL DEFAULT '{"version":2,"activeDispositions":{}}';