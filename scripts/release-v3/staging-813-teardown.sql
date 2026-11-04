-- Release V3: one-time staging teardown for #813 (merchant notifications).
--
-- Owner decision 2026-11-04: option A (renumber #813's migrations above the
-- lock to 511, 512 and 513) with staging plan S1 (undo and re-apply). Staging
-- applied #813's M499 and M502 before the V3 lock was taken, so they sit
-- inside the staging lock. This file removes exactly those objects and their two
-- ledger rows, so that the release later applies 511 to 513 to staging the same
-- way it applies them to production.
--
-- How to apply (separate Owner approval, STAGING ONLY):
--  * Run once, as one execution, through the SQL editor or an approved
--    execution on project tqjvrzopvtczxfxiwmnz. Not with `apply_migration`
--    (that would add a ledger row). It lives outside supabase/migrations.
--  * Before running it, export read-only (staging test data only):
--    - the rows of the three tables;
--    - both ledger rows in full: SELECT to_jsonb(m) FROM
--      supabase_migrations.schema_migrations m WHERE version IN
--      ('20261101181612','20261102002152');
--  * Run it in a fresh session. If it fails, the session is left in an
--    aborted transaction: run ROLLBACK or close the session.
--  * Undo (only if #872 is rejected after this ran): re-run the exact 499 and
--    502 file bytes from #813's history as the same role, then re-insert the
--    two exported ledger rows exactly. Staging then equals the previous lock
--    again (catalog 6400 80f4ec20..., ledger 444 adcdf3e9...).
--  * Releases cannot pass the gate between this teardown and the merge of
--    #872 (staging no longer matches main's lock), so do the two back to back.
--  * Afterwards, a read-only reading of staging must equal the updated
--    staging lock in lock.json plus the 509 and 510 deltas.
--
-- Fails closed. Everything runs in one transaction, so any failure leaves
-- staging unchanged:
--  * the two ledger rows must exist with the exact reviewed statement bytes
--    (production has neither, so the file aborts there);
--  * every DROP is explicit and RESTRICT, so an unexpected dependency aborts;
--  * the final check requires that no #813 object or ledger row remains.
BEGIN;
-- Do not queue behind long transactions while holding locks on orders,
-- bookings, reservations and payments.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF (SELECT count(*) FROM (SELECT 1 FROM supabase_migrations.schema_migrations
      WHERE (version, name, cardinality(statements), encode(sha256(convert_to(statements[1], 'UTF8')), 'hex')) IN (
        ('20261101181612', '499_merchant_notifications', 1, '86a31b70e2b806c762eea63face8a11c2ac1f38818a0e032f98d5bf48710c06e'),
        ('20261102002152', '502_merchant_notification_invitation_lifetime', 1, '9f6bad33195ca00744038b02491b8f2b8d1b7b407eebf9a1cf30e0560c49f2d6'))
      FOR UPDATE) reviewed) <> 2 THEN
    RAISE EXCEPTION '813 teardown: the two reviewed staging ledger rows are not present; this is not the expected staging database';
  END IF;
END $$;

DROP TRIGGER merchant_order_alert ON public.orders RESTRICT;
DROP TRIGGER merchant_booking_alert ON public.bookings RESTRICT;
DROP TRIGGER merchant_reservation_alert ON public.reservations RESTRICT;
DROP TRIGGER merchant_payment_alert ON public.payments RESTRICT;

DROP FUNCTION public.capture_merchant_notification() RESTRICT;
DROP FUNCTION public.claim_merchant_notification() RESTRICT;
DROP FUNCTION public.consume_merchant_notification_invitation(text, text, text, uuid) RESTRICT;
DROP FUNCTION public.create_merchant_notification_recipient(uuid, text, text, text, text[]) RESTRICT;
DROP FUNCTION public.fence_merchant_notification(uuid, uuid) RESTRICT;
DROP FUNCTION public.finish_merchant_notification(uuid, uuid, text, text, text) RESTRICT;
DROP FUNCTION public.issue_merchant_notification_invitation(uuid, uuid, text, uuid) RESTRICT;
DROP FUNCTION public.reserve_merchant_notification_allowance(uuid) RESTRICT;
DROP FUNCTION public.revoke_merchant_notification_whatsapp(text, uuid) RESTRICT;

-- Children first (they reference recipients).
DROP TABLE public.merchant_notification_deliveries RESTRICT;
DROP TABLE public.merchant_notification_invitations RESTRICT;
DROP TABLE public.merchant_notification_recipients RESTRICT;

DELETE FROM supabase_migrations.schema_migrations
WHERE (version, name, cardinality(statements), encode(sha256(convert_to(statements[1], 'UTF8')), 'hex')) IN (
  ('20261101181612', '499_merchant_notifications', 1, '86a31b70e2b806c762eea63face8a11c2ac1f38818a0e032f98d5bf48710c06e'),
  ('20261102002152', '502_merchant_notification_invitation_lifetime', 1, '9f6bad33195ca00744038b02491b8f2b8d1b7b407eebf9a1cf30e0560c49f2d6'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname LIKE 'merchant_notification%')
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE '%merchant_notification%')
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal
                AND t.tgrelid IN ('public.orders'::regclass, 'public.bookings'::regclass, 'public.reservations'::regclass, 'public.payments'::regclass)
                AND t.tgname IN ('merchant_order_alert', 'merchant_booking_alert', 'merchant_reservation_alert', 'merchant_payment_alert'))
     OR EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name LIKE '%merchant_notification%') THEN
    RAISE EXCEPTION '813 teardown: #813 objects or ledger rows remain';
  END IF;
END $$;

COMMIT;
