CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "booking_attendees_name_search_trgm_idx" ON "booking_attendees" USING gin (lower("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "booking_attendees_email_search_trgm_idx" ON "booking_attendees" USING gin (lower("email") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "bookings_title_search_trgm_idx" ON "bookings" USING gin (lower("title") gin_trgm_ops);