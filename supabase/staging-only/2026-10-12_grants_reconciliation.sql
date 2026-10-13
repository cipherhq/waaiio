-- ══════════════════════════════════════════════════════════════════════════
-- STAGING ONLY — never apply to production
-- Target: staging project tqjvrzopvtczxfxiwmnz
-- ══════════════════════════════════════════════════════════════════════════
--
-- HOW TO USE:
--   DRY RUN (default): run as-is. The file ends with ROLLBACK. All grants
--   and test fixtures are applied inside the transaction, the security proof
--   runs, and everything is rolled back. Nothing persists.
--
--   APPLY: change the last line from ROLLBACK to COMMIT, then run via
--   Supabase Management API with explicit Owner authorization.
--
-- Least-privilege grants reconciliation, derived from:
--   - Production effective privileges (has_table_privilege, 2026-10-12)
--   - Staging RLS policies (pg_policy + USING/WITH CHECK expressions)
--
-- Grant policy per role:
--   service_role: production mirror.
--   authenticated: production has it AND staging has a non-service-role-only
--     RLS policy for that command. Policies whose USING expression is purely
--     auth.role() = 'service_role' are excluded even if polroles = PUBLIC.
--   anon: only where a policy explicitly names the anon role.
--
-- Privilege scope: SELECT, INSERT, UPDATE, DELETE only.
--   Production also has TRUNCATE, REFERENCES, TRIGGER from Supabase
--   ALTER DEFAULT PRIVILEGES. Deliberately omitted (unused by app).
--
-- No ALTER DEFAULT PRIVILEGES in this file. See #622.
-- RLS-disabled: businesses_public, whatsapp_channels_public (views) —
--   service_role SELECT only, no anon/authenticated grants.
-- Over-grants: 0. Functions: out of scope (P0).

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════
-- §1  anon grants (3 relations)
-- ══════════════════════════════════════════════════════════════════════════
-- event_ticket_types/SELECT: polroles={anon,authenticated}, polcmd=r
-- events/SELECT: polroles={anon,authenticated}, polcmd=r
-- properties/SELECT: polroles={anon,authenticated}, polcmd=r

GRANT SELECT ON TABLE public.event_ticket_types TO anon;
GRANT SELECT ON TABLE public.events TO anon;
GRANT SELECT ON TABLE public.properties TO anon;

-- ══════════════════════════════════════════════════════════════════════════
-- §2a  authenticated grants (115 relations)
-- ══════════════════════════════════════════════════════════════════════════
-- Granted only where production has the privilege AND staging has a
-- non-service-role-only RLS policy for that command.

GRANT SELECT ON TABLE public.admin_audit_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_broadcasts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_role_permissions TO authenticated;
GRANT SELECT ON TABLE public.ai_classification_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_conversation_config TO authenticated;
GRANT SELECT ON TABLE public.ai_usage TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.alerts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_keys TO authenticated;
GRANT SELECT, DELETE ON TABLE public.attendance_log TO authenticated;
GRANT SELECT ON TABLE public.audit_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.blocked_phones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.booking_slots TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.bookings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_step_overrides TO authenticated;
GRANT SELECT ON TABLE public.broadcast_usage TO authenticated;
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
GRANT SELECT, DELETE ON TABLE public.chat_conversations TO authenticated;
GRANT SELECT ON TABLE public.chat_forward_usage TO authenticated;
GRANT SELECT ON TABLE public.chat_messages TO authenticated;
GRANT SELECT ON TABLE public.conversation_usage TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.countries TO authenticated;
GRANT SELECT ON TABLE public.customer_consents TO authenticated;
GRANT SELECT, DELETE ON TABLE public.customer_feedback TO authenticated;
GRANT SELECT, DELETE ON TABLE public.customer_profiles TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.customer_subscriptions TO authenticated;
GRANT SELECT ON TABLE public.daily_summary_log TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.demo_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_invites TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.event_tickets TO authenticated;
GRANT SELECT ON TABLE public.flow_dropoffs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_execution_aggregates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_execution_summaries TO authenticated;
GRANT SELECT, DELETE ON TABLE public.form_responses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.forms TO authenticated;
GRANT SELECT ON TABLE public.fraud_events TO authenticated;
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
GRANT SELECT ON TABLE public.llm_classifications TO authenticated;
GRANT SELECT, DELETE ON TABLE public.loyalty_points TO authenticated;
GRANT SELECT ON TABLE public.loyalty_transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.membership_tiers TO authenticated;
GRANT SELECT ON TABLE public.messaging_opt_outs TO authenticated;
GRANT SELECT ON TABLE public.messaging_suspension_audit TO authenticated;
GRANT SELECT, INSERT ON TABLE public.notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.package_enrollments TO authenticated;
GRANT SELECT ON TABLE public.package_redemptions TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.payment_links TO authenticated;
GRANT SELECT ON TABLE public.payout_accounts TO authenticated;
GRANT SELECT ON TABLE public.payout_adjustments TO authenticated;
GRANT SELECT, INSERT ON TABLE public.payout_terms_acceptance TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pending_transfers TO authenticated;
GRANT SELECT ON TABLE public.platform_config_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_fee_invoices TO authenticated;
GRANT SELECT ON TABLE public.platform_fees TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_addons TO authenticated;
GRANT SELECT ON TABLE public.promo_campaigns TO authenticated;
GRANT SELECT ON TABLE public.promo_code_batches TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.promo_codes TO authenticated;
GRANT SELECT ON TABLE public.promo_prizes TO authenticated;
GRANT SELECT ON TABLE public.promo_redemptions TO authenticated;
GRANT SELECT ON TABLE public.promo_verification_attempts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.properties TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.property_blocked_dates TO authenticated;
GRANT SELECT ON TABLE public.queue_reopen_subscriptions TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.quote_requests TO authenticated;
GRANT SELECT, DELETE ON TABLE public.referrals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.refund_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reseller_invoices TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.reseller_payouts TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.resellers TO authenticated;
GRANT SELECT ON TABLE public.security_events TO authenticated;
GRANT SELECT ON TABLE public.security_sessions TO authenticated;
GRANT DELETE ON TABLE public.service_addons TO authenticated;
GRANT DELETE ON TABLE public.service_packages TO authenticated;
GRANT SELECT ON TABLE public.signed_waivers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.site_pages TO authenticated;
GRANT SELECT ON TABLE public.subscription_charges TO authenticated;
GRANT SELECT ON TABLE public.subscription_payments TO authenticated;
GRANT SELECT ON TABLE public.subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_ticket_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_tickets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.verification_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.volume_discount_rules TO authenticated;
GRANT SELECT, DELETE ON TABLE public.waitlist_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.waiver_templates TO authenticated;
GRANT SELECT ON TABLE public.webhook_deliveries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_endpoints TO authenticated;
GRANT UPDATE, DELETE ON TABLE public.whatsapp_channels TO authenticated;

-- payout_accounts: least privilege — column-level UPDATE only
GRANT UPDATE (is_active, updated_at) ON TABLE public.payout_accounts TO authenticated;

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
-- §3  Security proof — in-transaction; failure rolls back everything
-- ══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  _user_a_id uuid := gen_random_uuid();
  _user_b_id uuid := gen_random_uuid();
  _biz_a_id  uuid := gen_random_uuid();
  _biz_b_id  uuid := gen_random_uuid();
  _pa_a_id   uuid := gen_random_uuid();
  _errors    text[] := '{}';
  _count     bigint;
BEGIN
  -- ── Create test fixtures as postgres ──────────────────────────────────
  INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, confirmed_at, created_at, updated_at)
  VALUES
    (_user_a_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'test-a-' || _user_a_id || '@test.local', crypt('testpass', gen_salt('bf')), now(), now(), now()),
    (_user_b_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'test-b-' || _user_b_id || '@test.local', crypt('testpass', gen_salt('bf')), now(), now(), now());

  INSERT INTO public.businesses (id, owner_id, name, slug, country, category, phone)
  VALUES
    (_biz_a_id, _user_a_id, 'Test Biz A', 'test-a-' || _biz_a_id, 'NG', 'retail', '+2340000000001'),
    (_biz_b_id, _user_b_id, 'Test Biz B', 'test-b-' || _biz_b_id, 'NG', 'retail', '+2340000000002');

  -- B's sensitive records
  INSERT INTO public.business_payouts (id, business_id, amount, status, currency, created_at)
  VALUES (gen_random_uuid(), _biz_b_id, 10000, 'pending', 'NGN', now());
  INSERT INTO public.payout_accounts (id, business_id, account_name, account_number, bank_code, created_at)
  VALUES (gen_random_uuid(), _biz_b_id, 'B Account', '1111111111', '058', now());
  INSERT INTO public.payout_adjustments (id, business_id, amount, reason, created_at)
  VALUES (gen_random_uuid(), _biz_b_id, 500, 'test', now());
  INSERT INTO public.business_documents (id, business_id, document_type, file_url, created_at)
  VALUES (gen_random_uuid(), _biz_b_id, 'id_card', '/test/doc.pdf', now());
  INSERT INTO public.verification_requests (id, business_id, status, created_at)
  VALUES (gen_random_uuid(), _biz_b_id, 'pending', now());
  INSERT INTO public.platform_fees (id, business_id, payment_id, amount, fee_type, created_at)
  VALUES (gen_random_uuid(), _biz_b_id, gen_random_uuid(), 100, 'platform', now());

  -- A's records (positive controls)
  INSERT INTO public.business_payouts (id, business_id, amount, status, currency, created_at)
  VALUES (gen_random_uuid(), _biz_a_id, 5000, 'pending', 'NGN', now());
  INSERT INTO public.payout_accounts (id, business_id, account_name, account_number, bank_code, is_active, created_at, updated_at)
  VALUES (_pa_a_id, _biz_a_id, 'A Account', '2222222222', '058', true, now(), now());

  -- ══════════════════════════════════════════════════════════════════════
  -- ANON assertions
  -- ══════════════════════════════════════════════════════════════════════
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '{}', true);

  -- anon_select_zero: SELECT returns 0 rows on sensitive tables
  SELECT count(*) INTO _count FROM public.business_payouts;
  IF _count > 0 THEN _errors := _errors || 'anon_select_zero: business_payouts=' || _count; END IF;
  SELECT count(*) INTO _count FROM public.payout_accounts;
  IF _count > 0 THEN _errors := _errors || 'anon_select_zero: payout_accounts=' || _count; END IF;
  SELECT count(*) INTO _count FROM public.payout_adjustments;
  IF _count > 0 THEN _errors := _errors || 'anon_select_zero: payout_adjustments=' || _count; END IF;
  SELECT count(*) INTO _count FROM public.business_documents;
  IF _count > 0 THEN _errors := _errors || 'anon_select_zero: business_documents=' || _count; END IF;
  SELECT count(*) INTO _count FROM public.verification_requests;
  IF _count > 0 THEN _errors := _errors || 'anon_select_zero: verification_requests=' || _count; END IF;
  SELECT count(*) INTO _count FROM public.platform_fees;
  IF _count > 0 THEN _errors := _errors || 'anon_select_zero: platform_fees=' || _count; END IF;

  -- anon_insert_blocked: INSERT raises
  BEGIN
    INSERT INTO public.business_payouts (id, business_id, amount, status, currency, created_at)
    VALUES (gen_random_uuid(), _biz_b_id, 999, 'pending', 'NGN', now());
    _errors := _errors || 'anon_insert_blocked: business_payouts INSERT succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;

  -- anon_update_zero: UPDATE affects 0 rows
  UPDATE public.business_payouts SET amount = 0;
  GET DIAGNOSTICS _count = ROW_COUNT;
  IF _count > 0 THEN _errors := _errors || 'anon_update_zero: business_payouts updated ' || _count; END IF;

  UPDATE public.payout_accounts SET account_name = 'hacked';
  GET DIAGNOSTICS _count = ROW_COUNT;
  IF _count > 0 THEN _errors := _errors || 'anon_update_zero: payout_accounts updated ' || _count; END IF;

  -- anon_delete_zero: DELETE affects 0 rows
  DELETE FROM public.business_payouts;
  GET DIAGNOSTICS _count = ROW_COUNT;
  IF _count > 0 THEN _errors := _errors || 'anon_delete_zero: business_payouts deleted ' || _count; END IF;

  DELETE FROM public.payout_accounts;
  GET DIAGNOSTICS _count = ROW_COUNT;
  IF _count > 0 THEN _errors := _errors || 'anon_delete_zero: payout_accounts deleted ' || _count; END IF;

  -- ══════════════════════════════════════════════════════════════════════
  -- CROSS-TENANT assertions (owner A vs B's data)
  -- ══════════════════════════════════════════════════════════════════════
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', _user_a_id, 'role', 'authenticated')::text, true);

  -- cross_tenant_select_zero
  SELECT count(*) INTO _count FROM public.business_payouts WHERE business_id = _biz_b_id;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_select_zero: business_payouts=' || _count; END IF;
  SELECT count(*) INTO _count FROM public.payout_accounts WHERE business_id = _biz_b_id;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_select_zero: payout_accounts=' || _count; END IF;
  SELECT count(*) INTO _count FROM public.payout_adjustments WHERE business_id = _biz_b_id;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_select_zero: payout_adjustments=' || _count; END IF;
  SELECT count(*) INTO _count FROM public.business_documents WHERE business_id = _biz_b_id;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_select_zero: business_documents=' || _count; END IF;
  SELECT count(*) INTO _count FROM public.verification_requests WHERE business_id = _biz_b_id;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_select_zero: verification_requests=' || _count; END IF;

  -- cross_tenant_update_zero
  UPDATE public.business_payouts SET amount = 0 WHERE business_id = _biz_b_id;
  GET DIAGNOSTICS _count = ROW_COUNT;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_update_zero: business_payouts=' || _count; END IF;

  UPDATE public.payout_accounts SET account_name = 'x' WHERE business_id = _biz_b_id;
  GET DIAGNOSTICS _count = ROW_COUNT;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_update_zero: payout_accounts=' || _count; END IF;

  -- cross_tenant_delete_zero
  DELETE FROM public.business_payouts WHERE business_id = _biz_b_id;
  GET DIAGNOSTICS _count = ROW_COUNT;
  IF _count > 0 THEN _errors := _errors || 'cross_tenant_delete_zero: business_payouts=' || _count; END IF;

  -- cross_tenant_insert_blocked: owner A cannot insert for business B
  BEGIN
    INSERT INTO public.payout_accounts (id, business_id, account_name, account_number, bank_code, created_at)
    VALUES (gen_random_uuid(), _biz_b_id, 'Evil', '9999999999', '058', now());
    _errors := _errors || 'cross_tenant_insert_blocked: payout_accounts INSERT for B succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.business_documents (id, business_id, document_type, file_url, created_at)
    VALUES (gen_random_uuid(), _biz_b_id, 'id_card', '/evil.pdf', now());
    _errors := _errors || 'cross_tenant_insert_blocked: business_documents INSERT for B succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.verification_requests (id, business_id, status, created_at)
    VALUES (gen_random_uuid(), _biz_b_id, 'pending', now());
    _errors := _errors || 'cross_tenant_insert_blocked: verification_requests INSERT for B succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;

  -- payout_adjustments_blocked: authenticated cannot INSERT/UPDATE/DELETE at all
  BEGIN
    INSERT INTO public.payout_adjustments (id, business_id, amount, reason, created_at)
    VALUES (gen_random_uuid(), _biz_a_id, 1, 'test', now());
    _errors := _errors || 'payout_adjustments_blocked: INSERT succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  UPDATE public.payout_adjustments SET amount = 0 WHERE business_id = _biz_a_id;
  GET DIAGNOSTICS _count = ROW_COUNT;
  IF _count > 0 THEN _errors := _errors || 'payout_adjustments_blocked: UPDATE affected ' || _count; END IF;

  DELETE FROM public.payout_adjustments WHERE business_id = _biz_a_id;
  GET DIAGNOSTICS _count = ROW_COUNT;
  IF _count > 0 THEN _errors := _errors || 'payout_adjustments_blocked: DELETE affected ' || _count; END IF;

  -- ══════════════════════════════════════════════════════════════════════
  -- POSITIVE CONTROLS (owner A on own data)
  -- ══════════════════════════════════════════════════════════════════════

  -- owner_reads_own_payout
  SELECT count(*) INTO _count FROM public.business_payouts WHERE business_id = _biz_a_id;
  IF _count = 0 THEN _errors := _errors || 'owner_reads_own_payout: 0 rows'; END IF;

  -- owner_reads_own_payout_account
  SELECT count(*) INTO _count FROM public.payout_accounts WHERE business_id = _biz_a_id;
  IF _count = 0 THEN _errors := _errors || 'owner_reads_own_payout_account: 0 rows'; END IF;

  -- payout_account_column_privilege: UPDATE bank columns raises
  BEGIN
    UPDATE public.payout_accounts SET account_number = '0000000000' WHERE id = _pa_a_id;
    _errors := _errors || 'payout_account_column_priv: account_number UPDATE succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.payout_accounts SET bank_code = '000' WHERE id = _pa_a_id;
    _errors := _errors || 'payout_account_column_priv: bank_code UPDATE succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- payout_account_deactivate: UPDATE is_active succeeds (positive control)
  UPDATE public.payout_accounts SET is_active = false, updated_at = now() WHERE id = _pa_a_id;
  GET DIAGNOSTICS _count = ROW_COUNT;
  IF _count = 0 THEN _errors := _errors || 'payout_account_deactivate: 0 rows updated'; END IF;

  -- ══════════════════════════════════════════════════════════════════════
  -- Cleanup and result
  -- ══════════════════════════════════════════════════════════════════════
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  DELETE FROM public.platform_fees WHERE business_id IN (_biz_a_id, _biz_b_id);
  DELETE FROM public.verification_requests WHERE business_id IN (_biz_a_id, _biz_b_id);
  DELETE FROM public.business_documents WHERE business_id IN (_biz_a_id, _biz_b_id);
  DELETE FROM public.payout_adjustments WHERE business_id IN (_biz_a_id, _biz_b_id);
  DELETE FROM public.payout_accounts WHERE business_id IN (_biz_a_id, _biz_b_id);
  DELETE FROM public.business_payouts WHERE business_id IN (_biz_a_id, _biz_b_id);
  DELETE FROM public.businesses WHERE id IN (_biz_a_id, _biz_b_id);
  DELETE FROM auth.users WHERE id IN (_user_a_id, _user_b_id);

  IF array_length(_errors, 1) > 0 THEN
    RAISE EXCEPTION 'SECURITY PROOF FAILED — rolling back all grants: %',
      array_to_string(_errors, E'\n  ');
  END IF;

  RAISE NOTICE 'Security proof passed: all assertions OK.';
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- DRY RUN default. To apply: change ROLLBACK to COMMIT.
-- ══════════════════════════════════════════════════════════════════════════
ROLLBACK;
