-- Additive Party slug foundation. Existing slugs, timestamps, rows and generators
-- are preserved. This is not a replay or ledger substitution for migration455.
BEGIN;

DO $foundation$
DECLARE slug_column record;
BEGIN
  IF to_regclass('public.parties') IS NULL THEN
    RAISE EXCEPTION 'party_foundation_table_missing';
  END IF;
  SELECT atttypid, atttypmod, attnotnull INTO slug_column
  FROM pg_attribute WHERE attrelid='public.parties'::regclass AND attname='slug' AND NOT attisdropped;
  IF FOUND AND (slug_column.attnotnull OR NOT (
    slug_column.atttypid='text'::regtype OR
    (slug_column.atttypid='varchar'::regtype AND (slug_column.atttypmod=-1 OR slug_column.atttypmod>=104))
  )) THEN RAISE EXCEPTION 'party_slug_type_incompatible'; END IF;
END $foundation$;

ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS slug text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_slug ON public.parties(slug) WHERE slug IS NOT NULL;

DO $contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_am am ON am.oid=c.relam
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname='slug' AND NOT a.attisdropped
    WHERE i.indexrelid=to_regclass('public.idx_parties_slug')
      AND i.indrelid='public.parties'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey[0]=a.attnum
      AND i.indexprs IS NULL AND am.amname='btree'
      AND (i.indpred IS NULL OR pg_get_expr(i.indpred,i.indrelid)='(slug IS NOT NULL)')
  ) THEN RAISE EXCEPTION 'party_slug_index_incompatible'; END IF;
END $contract$;

COMMIT;
