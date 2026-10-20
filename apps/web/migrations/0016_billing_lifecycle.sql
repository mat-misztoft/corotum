CREATE TABLE `billing_subscription_links` (
	`provider` text NOT NULL,
	`provider_subscription_id` text NOT NULL,
	`provider_customer_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_subscription_links_subscription_unique` ON `billing_subscription_links` (`provider`,`provider_subscription_id`);--> statement-breakpoint
CREATE INDEX `billing_subscription_links_customer` ON `billing_subscription_links` (`provider`,`provider_customer_id`);--> statement-breakpoint
ALTER TABLE `billing_events` ADD `provider_subscription_id` text;--> statement-breakpoint
ALTER TABLE `billing_events` ADD `provider_created_at` integer;--> statement-breakpoint
ALTER TABLE `billing_events` ADD `subscription_status` text;--> statement-breakpoint
CREATE INDEX `billing_events_subscription_time` ON `billing_events` (`provider`,`provider_subscription_id`,`provider_created_at`);--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `provider_product_id` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `trial_end` integer;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `grace_period_end` integer;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `event_priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `period_event_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `paid_event_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `paid_period_end` integer;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `past_due_at` integer;--> statement-breakpoint
INSERT INTO `billing_subscription_links` (`provider`, `provider_subscription_id`, `provider_customer_id`, `user_id`, `created_at`)
SELECT `provider`, `provider_subscription_id`, `provider_customer_id`, `user_id`, `created_at` FROM `subscriptions`;
