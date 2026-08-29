CREATE TABLE `device_agents` (
	`device_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "device_agents_agent_id_check" CHECK("device_agents"."agent_id" IN ('codex', 'claude-code', 'pi', 'gemini-cli', 'opencode', 'cursor', 'windsurf', 'cline', 'roo-code', 'github-copilot', 'kiro-cli')),
	CONSTRAINT "device_agents_status_check" CHECK("device_agents"."status" IN ('DETECTED', 'ENABLED', 'DISABLED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_agents_device_agent_unique` ON `device_agents` (`device_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `device_workspaces` (
	`device_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`applied_revision_sequence` integer DEFAULT 0 NOT NULL,
	`sync_status` text DEFAULT 'NEVER_SYNCED' NOT NULL,
	`last_sync_at` integer,
	`last_error_code` text,
	`last_error_message` text,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_workspaces_device_workspace_unique` ON `device_workspaces` (`device_id`,`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_workspaces_one_active_workspace_unique` ON `device_workspaces` (`device_id`) WHERE "device_workspaces"."is_active" = 1;--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`architecture` text NOT NULL,
	`cli_version` text NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
