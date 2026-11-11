-- ══════════════════════════════════════════════════════════
-- 527: A shared WhatsApp channel never has a business owner
--
-- A shared channel is platform transport. Businesses reach it through their
-- own businesses.assigned_channel_id; the channel row itself must never point
-- at one business. Dedicated channels keep business_id as their owner.
--
-- Staging incident (2026-11-10): the one staging shared channel carried a
-- business_id, so readiness correctly refused it and merchant links showed
-- "WhatsApp Unavailable". No app path writes that value (channel rows are only
-- created as 'dedicated' by promote_channel_candidate), but channel_type
-- defaults to 'shared' and nothing in the database stopped a hand-made row
-- from being both shared and owned. This constraint does.
--
-- Changes no data. If any shared channel still has a business_id, the
-- migration stops with the count and changes nothing; clearing it is a
-- separate, Owner-approved data repair.
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE
  v_owned integer;
BEGIN
  SELECT count(*) INTO v_owned
    FROM public.whatsapp_channels
   WHERE channel_type = 'shared'
     AND business_id IS NOT NULL;
  IF v_owned > 0 THEN
    RAISE EXCEPTION 'M527: % shared whatsapp_channels row(s) have a business_id. Clear them with an Owner-approved repair, then re-run.', v_owned;
  END IF;
END $$;

ALTER TABLE public.whatsapp_channels
  DROP CONSTRAINT IF EXISTS chk_shared_channel_has_no_owner;
ALTER TABLE public.whatsapp_channels
  ADD CONSTRAINT chk_shared_channel_has_no_owner
  CHECK (channel_type IS DISTINCT FROM 'shared' OR business_id IS NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_shared_channel_has_no_owner'
       AND conrelid = 'public.whatsapp_channels'::regclass
       AND contype = 'c'
       AND convalidated
  ) THEN
    RAISE EXCEPTION 'M527: chk_shared_channel_has_no_owner missing or not validated';
  END IF;
END $$;
