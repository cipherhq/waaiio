-- ══════════════════════════════════════════════════════════════════════════
-- STAGING ONLY — never apply to production
-- Apply only with explicit Owner authorization via Supabase Management API
-- Target: staging project tqjvrzopvtczxfxiwmnz
-- ══════════════════════════════════════════════════════════════════════════
--
-- Least-privilege grants reconciliation for staging, derived from:
--   - Production effective privileges (has_table_privilege, 2026-10-12)
--   - Staging RLS policies (pg_policy, polcmd, polroles)
--
-- Grant policy per role:
--   service_role: production mirror — if production has it, staging gets it.
--   authenticated: grant only if production has it AND staging has at least
--     one RLS policy for that command whose roles include authenticated or
--     PUBLIC.
--   anon: grant nothing unless a policy explicitly names the anon role for
--     that command AND production grants it. Only 3 anon grants issued.
--
-- Privilege scope: SELECT, INSERT, UPDATE, DELETE only.
--   Production also has TRUNCATE, REFERENCES, TRIGGER from Supabase
--   ALTER DEFAULT PRIVILEGES (arwdDxtm). These are deliberately omitted:
--   the app never uses them via API roles. This is a least-privilege
--   choice for existing relations.
--
-- No ALTER DEFAULT PRIVILEGES in this file. See #622 for the forward
-- policy: explicit grants per migration + CI check.
--
-- RLS-disabled relations: businesses_public (view), whatsapp_channels_public
-- (view). No anon/authenticated grants issued for these; only service_role
-- SELECT (production mirror).
--
-- Over-grants (staging has, production lacks): 0
-- Functions: out of scope (P0)
--
-- DRY RUN mode: change COMMIT on the last line to ROLLBACK. The security
-- proof in §3 will still run and report results, but all changes
-- (grants + test fixtures) will be rolled back. Use this to verify on
-- staging without changing anything.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════
-- §1  anon grants (3 relations)
-- ══════════════════════════════════════════════════════════════════════════
-- Each grant is justified by an RLS policy that explicitly names the anon
-- role for the corresponding command.
--
-- event_ticket_types / SELECT: policy "event_ticket_types_anon_select"
--   polroles = {anon, authenticated}, polcmd = r
-- events / SELECT: policy "events_anon_select"
--   polroles = {anon, authenticated}, polcmd = r
-- properties / SELECT: policy "properties_anon_select"
--   polroles = {anon, authenticated}, polcmd = r

GRANT SELECT ON TABLE public.event_ticket_types TO anon;
GRANT SELECT ON TABLE public.events TO anon;
GRANT SELECT ON TABLE public.properties TO anon;

-- ══════════════════════════════════════════════════════════════════════════
-- §2a  authenticated grants (128 relations)
-- ══════════════════════════════════════════════════════════════════════════
-- Granted only where production has the privilege AND staging has a policy
-- for that command with roles including authenticated or PUBLIC.

GRANT SELECT ON TABLE public.admin_audit_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_broadcasts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_impersonation_tokens TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_role_permissions TO authenticated;
GRANT SELECT ON TABLE public.ai_classification_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_conversation_config TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_usage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.alerts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_keys TO authenticated;
GRANT SELECT, DELETE ON TABLE public.attendance_log TO authenticated;
GRANT SELECT, INSERT ON TABLE public.audit_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.blocked_phones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.booking_slots TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.bookings TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.bot_keywords TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_rules TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.bot_sequence_enrollments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_step_overrides TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.broadcast_usage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_bank_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_broadcasts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_faq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_locations TO authenticated;
GRANT SELECT ON TABLE public.business_payment_credentials TO authenticated;
GRANT SELECT ON TABLE public.business_payouts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_staff TO authenticated;
GRANT DELETE ON TABLE public.businesses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.campaign_donations TO authenticated;
GRANT DELETE ON TABLE public.campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.canned_responses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.catalog_sync_logs TO authenticated;
GRANT SELECT ON TABLE public.category_definitions TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.category_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_forward_usage TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.chat_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contract_signers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contract_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contracts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.conversation_usage TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.countries TO authenticated;
GRANT SELECT ON TABLE public.customer_consents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_feedback TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_reports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_subscriptions TO authenticated;
GRANT SELECT, INSERT ON TABLE public.daily_summary_log TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.demo_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_invites TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.event_tickets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_dropoffs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_execution_aggregates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_execution_summaries TO authenticated;
GRANT SELECT, DELETE ON TABLE public.form_responses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.forms TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fraud_events TO authenticated;
GRANT SELECT ON TABLE public.growth_campaign_recipients TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_contacts TO authenticated;
GRANT SELECT, INSERT ON TABLE public.growth_credit_transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_credits TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_imports TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.growth_pricing TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.impersonation_logs TO authenticated;
GRANT UPDATE ON TABLE public.invoice_items TO authenticated;
GRANT DELETE ON TABLE public.invoices TO authenticated;
GRANT SELECT, INSERT ON TABLE public.keyword_campaign_responses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.keyword_campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.launch_delivery_confirmations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.launch_subscribers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.llm_classifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.loyalty_points TO authenticated;
GRANT SELECT, INSERT ON TABLE public.loyalty_transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.membership_tiers TO authenticated;
GRANT SELECT ON TABLE public.messaging_opt_outs TO authenticated;
GRANT SELECT ON TABLE public.messaging_suspension_audit TO authenticated;
GRANT SELECT, INSERT ON TABLE public.notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_tracking_notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.package_enrollments TO authenticated;
GRANT SELECT ON TABLE public.package_redemptions TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.payment_links TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payout_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_adjustments TO authenticated;
GRANT SELECT, INSERT ON TABLE public.payout_terms_acceptance TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pending_transfers TO authenticated;
GRANT SELECT ON TABLE public.platform_config_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_fee_invoices TO authenticated;
GRANT SELECT ON TABLE public.platform_fees TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.poll_votes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_addons TO authenticated;
GRANT SELECT ON TABLE public.promo_campaigns TO authenticated;
GRANT SELECT ON TABLE public.promo_code_batches TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.promo_codes TO authenticated;
GRANT SELECT ON TABLE public.promo_prizes TO authenticated;
GRANT SELECT ON TABLE public.promo_redemptions TO authenticated;
GRANT SELECT ON TABLE public.promo_verification_attempts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.properties TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.property_blocked_dates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.queue_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.queue_reopen_subscriptions TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.quote_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.referrals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.refund_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reseller_invoices TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.reseller_payouts TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.resellers TO authenticated;
GRANT INSERT, DELETE ON TABLE public.reservations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.saved_payment_methods TO authenticated;
GRANT SELECT ON TABLE public.security_events TO authenticated;
GRANT SELECT ON TABLE public.security_sessions TO authenticated;
GRANT DELETE ON TABLE public.service_addons TO authenticated;
GRANT DELETE ON TABLE public.service_packages TO authenticated;
GRANT SELECT ON TABLE public.signed_waivers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.site_pages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_charges TO authenticated;
GRANT SELECT ON TABLE public.subscription_payments TO authenticated;
GRANT SELECT ON TABLE public.subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_ticket_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_tickets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.survey_responses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.verification_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.volume_discount_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.waitlist_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.waiver_templates TO authenticated;
GRANT SELECT ON TABLE public.webhook_deliveries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_endpoints TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.whatsapp_channels TO authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- §2b  service_role grants (148 relations) — production mirror
-- ══════════════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_broadcasts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_role_permissions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_classification_log TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.ai_conversation_config TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_usage TO service_role;
GRANT UPDATE, DELETE ON TABLE public.alerts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_keys TO service_role;
GRANT UPDATE, DELETE ON TABLE public.attendance_log TO service_role;
GRANT UPDATE, DELETE ON TABLE public.audit_log TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.blocked_phones TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.booking_confirmation_intents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.booking_slots TO service_role;
GRANT INSERT, DELETE ON TABLE public.bookings TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.bot_keywords TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.bot_rules TO service_role;
GRANT DELETE ON TABLE public.bot_sequence_enrollments TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.bot_sequence_steps TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.bot_sequences TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.bot_step_overrides TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.broadcast_usage TO service_role;
GRANT DELETE ON TABLE public.business_bank_accounts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_broadcasts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_documents TO service_role;
GRANT DELETE ON TABLE public.business_payment_credentials TO service_role;
GRANT SELECT ON TABLE public.businesses_public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.campaign_donations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.campaigns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.catalog_sync_logs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.category_definitions TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.category_templates TO service_role;
GRANT DELETE ON TABLE public.chat_conversations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_forward_usage TO service_role;
GRANT UPDATE ON TABLE public.chat_messages TO service_role;
GRANT DELETE ON TABLE public.contract_signers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contract_templates TO service_role;
GRANT DELETE ON TABLE public.contracts TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.conversation_usage TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_consents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_feedback TO service_role;
GRANT DELETE ON TABLE public.customer_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_reports TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_subscriptions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.daily_summary_log TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.delivery_zones TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.demo_requests TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_invites TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_ticket_types TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_tickets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_dropoffs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_execution_aggregates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_execution_summaries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.form_responses TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.forms TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fraud_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_campaign_recipients TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_campaigns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_contacts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_credit_transactions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_credits TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_imports TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_pricing TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.impersonation_logs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoice_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoice_payment_applications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoices TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.keyword_campaign_responses TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.keyword_campaigns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.launch_delivery_confirmations TO service_role;
GRANT DELETE ON TABLE public.launch_subscribers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.llm_classifications TO service_role;
GRANT DELETE ON TABLE public.loyalty_points TO service_role;
GRANT UPDATE, DELETE ON TABLE public.loyalty_transactions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.membership_tiers TO service_role;
GRANT DELETE ON TABLE public.message_send_attempts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messaging_opt_outs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messaging_suspension_audit TO service_role;
GRANT UPDATE, DELETE ON TABLE public.notifications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_spend_applications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_stock_applications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_tracking_notifications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.package_enrollments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.package_redemptions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.parties TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.payment_confirmation_deliveries TO service_role;
GRANT DELETE ON TABLE public.payment_links TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_spend_applications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_visit_applications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_accounts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_adjustments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_terms_acceptance TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.paystack_billing_attempts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pending_transfers TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.platform_config_versions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_fee_invoices TO service_role;
GRANT UPDATE, DELETE ON TABLE public.platform_fees TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.poll_votes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.polls TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_addons TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_campaign_codes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_campaigns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_code_batches TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_eligibility_acks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_fulfillment_notification_intents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_pending_eligibility TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_prizes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_redemptions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_reservations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_verification_attempts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_winner_contacts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.properties TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.property_blocked_dates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.provider_cleanup_operations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.provider_customer_identities TO service_role;
GRANT INSERT, DELETE ON TABLE public.queue_entries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.queue_reopen_subscriptions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_requests TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.recurring_setup_intents TO service_role;
GRANT DELETE ON TABLE public.referrals TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.refund_requests TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reseller_invoices TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.resellers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reservations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.saved_card_auth_attempts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.security_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.security_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.service_addons TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.service_packages TO service_role;
GRANT UPDATE, DELETE ON TABLE public.signed_waivers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.site_pages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stripe_recurring_finalizations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_charges TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_checkout_intents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_payment_quarantine TO service_role;
GRANT UPDATE, DELETE ON TABLE public.subscription_payments TO service_role;
GRANT DELETE ON TABLE public.subscriptions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_ticket_messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_tickets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.survey_responses TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.surveys TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.unmatched_delivery_statuses TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.verification_requests TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.volume_discount_rules TO service_role;
GRANT INSERT, DELETE ON TABLE public.waitlist_entries TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.waiver_templates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_deliveries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_endpoints TO service_role;
GRANT SELECT ON TABLE public.whatsapp_channels_public TO service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- §3  Security proof — in-transaction, rolls back on any failure
-- ══════════════════════════════════════════════════════════════════════════
-- Creates temporary test fixtures (2 businesses, payouts, etc.) inside the
-- transaction. Asserts RLS isolation for anon and cross-tenant authenticated.
-- All fixtures are rolled back with the transaction (or COMMIT deletes them
-- via the cleanup block).
--
-- Assertions:
--   anon_select_zero:           anon sees 0 rows on sensitive tables
--   anon_insert_blocked:        anon cannot insert into business_payouts
--   cross_tenant_select_zero:   owner of A cannot read B's payout
--   cross_tenant_update_zero:   owner of A cannot update B's payout
--   cross_tenant_delete_zero:   owner of A cannot delete B's payout
--   owner_reads_own_payout:     owner of A can read A's payout (positive)

DO $$
DECLARE
  _user_a_id uuid := gen_random_uuid();
  _user_b_id uuid := gen_random_uuid();
  _biz_a_id  uuid := gen_random_uuid();
  _biz_b_id  uuid := gen_random_uuid();
  _errors    text[] := '{}';
  _count     bigint;
  _saved_role text;
BEGIN
  -- Save current role for restoration
  _saved_role := current_setting('role');

  -- ── Create test fixtures as postgres ──────────────────────────────────

  -- Users (minimal auth.users rows)
  INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, confirmed_at, created_at, updated_at)
  VALUES
    (_user_a_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'test-a-' || _user_a_id || '@test.local', crypt('testpass', gen_salt('bf')), now(), now(), now()),
    (_user_b_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'test-b-' || _user_b_id || '@test.local', crypt('testpass', gen_salt('bf')), now(), now(), now());

  -- Businesses
  INSERT INTO public.businesses (id, owner_id, name, slug, country, category, phone)
  VALUES
    (_biz_a_id, _user_a_id, 'Test Biz A', 'test-biz-a-' || _biz_a_id, 'NG', 'retail', '+2340000000001'),
    (_biz_b_id, _user_b_id, 'Test Biz B', 'test-biz-b-' || _biz_b_id, 'NG', 'retail', '+2340000000002');

  -- B's sensitive records
  INSERT INTO public.business_payouts (id, business_id, amount, status, currency, created_at)
  VALUES (gen_random_uuid(), _biz_b_id, 10000, 'pending', 'NGN', now());

  INSERT INTO public.payout_accounts (id, business_id, account_name, account_number, bank_code, created_at)
  VALUES (gen_random_uuid(), _biz_b_id, 'Test Account', '0000000000', '058', now());

  INSERT INTO public.payout_adjustments (id, business_id, amount, reason, created_at)
  VALUES (gen_random_uuid(), _biz_b_id, 500, 'test adjustment', now());

  INSERT INTO public.business_documents (id, business_id, document_type, file_url, created_at)
  VALUES (gen_random_uuid(), _biz_b_id, 'id_card', '/test/doc.pdf', now());

  INSERT INTO public.verification_requests (id, business_id, status, created_at)
  VALUES (gen_random_uuid(), _biz_b_id, 'pending', now());

  INSERT INTO public.platform_fees (id, business_id, payment_id, amount, fee_type, created_at)
  VALUES (gen_random_uuid(), _biz_b_id, gen_random_uuid(), 100, 'platform', now());

  -- A's payout (for positive control)
  INSERT INTO public.business_payouts (id, business_id, amount, status, currency, created_at)
  VALUES (gen_random_uuid(), _biz_a_id, 5000, 'pending', 'NGN', now());

  -- ── Assertion 1: anon_select_zero ─────────────────────────────────────
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '{}', true);

  SELECT count(*) INTO _count FROM public.business_payouts;
  IF _count > 0 THEN _errors := _errors || 'anon_select_zero: business_payouts returned ' || _count || ' rows'; END IF;

  SELECT count(*) INTO _count FROM public.payout_accounts;
  IF _count > 0 THEN _errors := _errors || 'anon_select_zero: payout_accounts returned ' || _count || ' rows'; END IF;

  SELECT count(*) INTO _count FROM public.payout_adjustments;
  IF _count > 0 THEN _errors := _errors || 'anon_select_zero: payout_adjustments returned ' || _count || ' rows'; END IF;

  SELECT count(*) INTO _count FROM public.business_documents;
  IF _count > 0 THEN _errors := _errors || 'anon_select_zero: business_documents returned ' || _count || ' rows'; END IF;

  SELECT count(*) INTO _count FROM public.verification_requests;
  IF _count > 0 THEN _errors := _errors || 'anon_select_zero: verification_requests returned ' || _count || ' rows'; END IF;

  SELECT count(*) INTO _count FROM public.platform_fees;
  IF _count > 0 THEN _errors := _errors || 'anon_select_zero: platform_fees returned ' || _count || ' rows'; END IF;

  -- ── Assertion 2: anon_insert_blocked ──────────────────────────────────
  BEGIN
    INSERT INTO public.business_payouts (id, business_id, amount, status, currency, created_at)
    VALUES (gen_random_uuid(), _biz_b_id, 999, 'pending', 'NGN', now());
    _errors := _errors || 'anon_insert_blocked: INSERT into business_payouts succeeded (should fail)';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    NULL; -- expected
  END;

  -- ── Assertion 3: cross_tenant_select_zero ─────────────────────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', _user_a_id, 'role', 'authenticated')::text, true);

  SELECT count(*) INTO _count FROM public.business_payouts WHERE business_id = _biz_b_id;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_select_zero: owner A read ' || _count || ' of B''s payouts'; END IF;

  SELECT count(*) INTO _count FROM public.payout_accounts WHERE business_id = _biz_b_id;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_select_zero: payout_accounts leaked ' || _count || ' rows'; END IF;

  SELECT count(*) INTO _count FROM public.payout_adjustments WHERE business_id = _biz_b_id;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_select_zero: payout_adjustments leaked ' || _count || ' rows'; END IF;

  SELECT count(*) INTO _count FROM public.business_documents WHERE business_id = _biz_b_id;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_select_zero: business_documents leaked ' || _count || ' rows'; END IF;

  SELECT count(*) INTO _count FROM public.verification_requests WHERE business_id = _biz_b_id;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_select_zero: verification_requests leaked ' || _count || ' rows'; END IF;

  -- ── Assertion 4: cross_tenant_update_zero ──────────────────────────────
  UPDATE public.business_payouts SET amount = 0 WHERE business_id = _biz_b_id;
  GET DIAGNOSTICS _count = ROW_COUNT;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_update_zero: updated ' || _count || ' of B''s payouts'; END IF;

  -- ── Assertion 5: cross_tenant_delete_zero ──────────────────────────────
  DELETE FROM public.business_payouts WHERE business_id = _biz_b_id;
  GET DIAGNOSTICS _count = ROW_COUNT;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_delete_zero: deleted ' || _count || ' of B''s payouts'; END IF;

  -- ── Assertion 6: owner_reads_own_payout (positive control) ────────────
  SELECT count(*) INTO _count FROM public.business_payouts WHERE business_id = _biz_a_id;
  IF _count = 0 THEN _errors := _errors || 'owner_reads_own_payout: owner A cannot read own payout (0 rows)'; END IF;

  -- ── Restore role and clean up ─────────────────────────────────────────
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  -- Delete test fixtures (so COMMIT leaves no artifacts)
  DELETE FROM public.platform_fees WHERE business_id IN (_biz_a_id, _biz_b_id);
  DELETE FROM public.verification_requests WHERE business_id IN (_biz_a_id, _biz_b_id);
  DELETE FROM public.business_documents WHERE business_id IN (_biz_a_id, _biz_b_id);
  DELETE FROM public.payout_adjustments WHERE business_id IN (_biz_a_id, _biz_b_id);
  DELETE FROM public.payout_accounts WHERE business_id IN (_biz_a_id, _biz_b_id);
  DELETE FROM public.business_payouts WHERE business_id IN (_biz_a_id, _biz_b_id);
  DELETE FROM public.businesses WHERE id IN (_biz_a_id, _biz_b_id);
  DELETE FROM auth.users WHERE id IN (_user_a_id, _user_b_id);

  -- ── Report ────────────────────────────────────────────────────────────
  IF array_length(_errors, 1) > 0 THEN
    RAISE EXCEPTION 'SECURITY PROOF FAILED — rolling back all grants: %',
      array_to_string(_errors, E'\n  ');
  END IF;

  RAISE NOTICE 'Security proof passed: 6/6 assertions OK.';
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- To dry-run: change COMMIT to ROLLBACK below.
-- ══════════════════════════════════════════════════════════════════════════
COMMIT;
