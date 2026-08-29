CREATE TABLE `device_skill_targets` (
	`device_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`content_hash` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "device_skill_targets_agent_id_check" CHECK("device_skill_targets"."agent_id" IN ('codex', 'claude-code', 'pi', 'gemini-cli', 'opencode', 'cursor', 'windsurf', 'cline', 'roo-code', 'github-copilot', 'kiro-cli')),
	CONSTRAINT "device_skill_targets_status_check" CHECK("device_skill_targets"."status" IN ('SYNCED', 'DRIFTED', 'AUTH_REQUIRED', 'ERROR'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_skill_targets_unique` ON `device_skill_targets` (`device_id`,`workspace_id`,`skill_id`,`agent_id`);