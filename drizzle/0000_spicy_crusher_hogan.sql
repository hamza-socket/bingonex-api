CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`p1_id` text NOT NULL,
	`p2_id` text NOT NULL,
	`p1_card` text NOT NULL,
	`p2_card` text NOT NULL,
	`called` text NOT NULL,
	`turn` text DEFAULT 'p1' NOT NULL,
	`p1_lines` integer DEFAULT 0 NOT NULL,
	`p2_lines` integer DEFAULT 0 NOT NULL,
	`move_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`p1_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`p2_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `games_p1_idx` ON `games` (`p1_id`);--> statement-breakpoint
CREATE INDEX `games_p2_idx` ON `games` (`p2_id`);--> statement-breakpoint
CREATE TABLE `match_queue` (
	`user_id` text PRIMARY KEY NOT NULL,
	`card` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_sub` text,
	`email` text,
	`name` text NOT NULL,
	`avatar_url` text,
	`is_guest` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);