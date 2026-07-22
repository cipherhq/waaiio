-- 249: Reseller payout overlap constraint
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE public.reseller_payouts
    ADD CONSTRAINT reseller_payouts_no_overlap
    EXCLUDE USING gist (
      reseller_id WITH =,
      daterange(period_start, period_end) WITH &&
    )
    WHERE (status != 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
