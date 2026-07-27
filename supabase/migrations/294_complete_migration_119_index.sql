-- Migration 294: Complete Migration 119 partial application
--
-- Migration 119 (119_forms.sql) created the forms and form_responses tables,
-- their RLS policies, and most indexes. Production preflight on 2026-07-27
-- confirmed that all tables, policies, and constraints exist, but two
-- indexes were not created during the original partial application:
--
--   1. idx_forms_token — SUPERSEDED by forms_token_key (UNIQUE constraint
--      from the table definition). No action needed.
--
--   2. idx_form_responses_business — MISSING. Created below.
--
-- This migration completes the original intent of Migration 119 without
-- rerunning or modifying that historical file. After this migration is
-- production-verified, Migration 119 can be marked as applied in the
-- remote migration history.
--
-- Production preflight evidence:
--   - form_responses table: 5 rows, 8 KB
--   - No existing index covers business_id on form_responses
--   - Standard CREATE INDEX is appropriate (table is tiny; lock is negligible)
--   - CREATE INDEX CONCURRENTLY is unnecessary and incompatible with the
--     Supabase Management API's implicit transaction wrapping

CREATE INDEX IF NOT EXISTS idx_form_responses_business
  ON public.form_responses (business_id);
