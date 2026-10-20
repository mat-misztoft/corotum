ALTER TABLE `subscriptions` ADD `event_created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `subscription_created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- ponytail: legacy rows use receipt times; reconcile with Creem if historic events need replaying.
UPDATE `subscriptions` SET `event_created_at` = `updated_at`, `subscription_created_at` = `created_at`;
