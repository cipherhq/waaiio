-- ══════════════════════════════════════════════════════════
-- 509: Restaurant "table" keyword matches whole words only
--
-- Owner decision 2026-11-04. Migration 041 seeded the category keyword
-- 'table' (restaurant) with match_type 'contains', and 164 pointed it at
-- table_reservation. keyword-service matches 'contains' with a substring
-- check, so "vegetable", "comfortable" or "timetable" also started a table
-- reservation.
--
-- This changes ONLY those seeded category rows to a word-boundary regex
-- (keyword-service already supports match_type 'regex', compiled with the
-- 'i' flag in JavaScript):
--   \btables?\b  →  matches "table" and "tables" as whole words only.
-- The generic 'contains' behaviour is unchanged (merchant keywords rely on it).
-- 'dine-in' is left as is: a hyphenated phrase has no realistic substring
-- false positives.
--
-- The pattern is written as an E'' string so the stored value is exactly
-- \btables?\b whatever standard_conforming_strings is set to.
--
-- Data-only. Idempotent: a re-run finds no 'contains' rows left to change.
-- No schema, grant, RLS or function change.
-- ══════════════════════════════════════════════════════════

UPDATE public.bot_keywords
SET keyword = E'\\btables?\\b',
    match_type = 'regex'
WHERE scope = 'category'
  AND category IN ('restaurant', 'cafe', 'bar', 'lounge')
  AND keyword = 'table'
  AND match_type = 'contains'
  AND action_type = 'start_capability';

-- ── Self-check ──
DO $$
DECLARE
  v_left INTEGER;
  v_bad INTEGER;
BEGIN
  SELECT count(*) INTO v_left
  FROM public.bot_keywords
  WHERE scope = 'category'
    AND category IN ('restaurant', 'cafe', 'bar', 'lounge')
    AND keyword = 'table'
    AND match_type = 'contains'
    AND action_type = 'start_capability';
  IF v_left > 0 THEN
    RAISE EXCEPTION '509 SELF-CHECK FAILED: % substring table keyword row(s) remain', v_left;
  END IF;

  -- Every whole-word row must be a regex row (the pattern means nothing as 'contains').
  SELECT count(*) INTO v_bad
  FROM public.bot_keywords
  WHERE scope = 'category'
    AND keyword = E'\\btables?\\b'
    AND match_type <> 'regex';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '509 SELF-CHECK FAILED: % whole-word table keyword row(s) are not regex', v_bad;
  END IF;

  RAISE NOTICE '509 SELF-CHECK PASSED: restaurant table keyword is whole-word only';
END $$;
