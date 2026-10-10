-- ═══════════════════════════════════════════════════════
-- Migration 437: Native WhatsApp Forms columns (#591 Phase 2)
--
-- Extends forms and form_responses tables for WhatsApp
-- native Flow integration. No new tables, no SECURITY
-- DEFINER functions. Existing RLS policies cover new
-- columns (policy predicates reference the row, not
-- specific columns).
-- ═══════════════════════════════════════════════════════

-- ── forms: Meta Flow lifecycle columns ──

ALTER TABLE forms
  ADD COLUMN IF NOT EXISTS meta_flow_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS meta_flow_status VARCHAR(20) DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS native_flow_json JSONB;

-- CHECK constraint on meta_flow_status (separate statement for IF NOT EXISTS safety)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'forms_meta_flow_status_check'
      AND conrelid = 'public.forms'::regclass
  ) THEN
    ALTER TABLE forms
      ADD CONSTRAINT forms_meta_flow_status_check
      CHECK (meta_flow_status IN ('draft', 'published', 'deprecated', 'blocked'));
  END IF;
END $$;

-- ── form_responses: native submission columns ──

ALTER TABLE form_responses
  ADD COLUMN IF NOT EXISTS submission_source VARCHAR(10) DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS flow_token_hash VARCHAR(128),
  ADD COLUMN IF NOT EXISTS consent_given BOOLEAN;

-- CHECK constraint on submission_source
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'form_responses_submission_source_check'
      AND conrelid = 'public.form_responses'::regclass
  ) THEN
    ALTER TABLE form_responses
      ADD CONSTRAINT form_responses_submission_source_check
      CHECK (submission_source IN ('web', 'native'));
  END IF;
END $$;

-- ── Unique index for replay prevention ──
-- Only non-null hashes are constrained; web submissions have NULL flow_token_hash.
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_responses_flow_token_hash
  ON form_responses (flow_token_hash)
  WHERE flow_token_hash IS NOT NULL;
