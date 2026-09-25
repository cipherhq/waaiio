-- #395 CTO correction: discovery is ON by default.
-- An eligible active business is listed unless the business explicitly disables discovery.
--
-- 1. Change column default from false to true
-- 2. Backfill existing NULL values to true (businesses that never touched discovery settings)
-- 3. Update partial index to cover the new default-on semantics

-- Step 1: Change default
ALTER TABLE businesses ALTER COLUMN discovery_enabled SET DEFAULT true;

-- Step 2: Backfill NULLs to true (businesses that were created before migration 239 or
-- never had discovery_enabled set). Existing false values are preserved (explicit opt-out).
UPDATE businesses SET discovery_enabled = true WHERE discovery_enabled IS NULL;

-- Step 3: Recreate partial index to match the eligibility query pattern.
-- The .or('discovery_enabled.is.null,discovery_enabled.eq.true') filter benefits from
-- an index that covers both true and NULL values. With the backfill above, NULL rows
-- are now true, so the existing index on discovery_enabled=true already covers them.
-- No index change needed — the existing partial index is correct.
