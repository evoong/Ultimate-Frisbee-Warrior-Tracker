-- Add secondary_assister_id to game_events for tracking 2nd assist (hockey assist)
ALTER TABLE "public"."game_events"
    ADD COLUMN IF NOT EXISTS "secondary_assister_id" integer;

ALTER TABLE "public"."game_events"
    ADD CONSTRAINT "game_events_secondary_assister_id_fkey"
    FOREIGN KEY ("secondary_assister_id")
    REFERENCES "public"."players"("id")
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_game_events_secondary_assister_id"
    ON "public"."game_events" USING "btree" ("secondary_assister_id");
