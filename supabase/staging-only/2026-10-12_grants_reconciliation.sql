-- ══════════════════════════════════════════════════════════════════════════
-- STAGING ONLY — never apply to production
-- Apply only with explicit Owner authorization via Supabase Management API
-- Target: staging project tqjvrzopvtczxfxiwmnz
-- ══════════════════════════════════════════════════════════════════════════
--
-- Reconcile staging table and view grants to match production.
--
-- Root cause: staging pg_default_acl has 18 entries; production has 27.
-- The 9 missing entries are all in the public schema (tables + sequences
-- + functions) for roles postgres and supabase_admin. Without these,
-- tables/views created by migrations have no privileges for
-- anon/authenticated/service_role unless explicitly GRANTed.
--
-- Deliberate deviation — TRUNCATE, REFERENCES, TRIGGER:
--   Production's Supabase defaults (arwdDxtm) grant TRUNCATE (D),
--   REFERENCES (x), TRIGGER (t), and MAINTAIN (m) in addition to
--   SELECT/INSERT/UPDATE/DELETE. This file grants only S/I/U/D because
--   the application never uses TRUNCATE, REFERENCES, or TRIGGER via
--   API roles. This is a least-privilege choice: staging will have
--   narrower DML-only grants on existing relations, while §1's
--   ALTER DEFAULT PRIVILEGES (GRANT ALL) matches production's full
--   privilege set for future tables — including TRUNCATE/REFERENCES/TRIGGER.
--
-- This file contains:
--   §1  ALTER DEFAULT PRIVILEGES — 2 entries (tables + sequences;
--       functions excluded per P0 review)
--   §2  Exact GRANT diff — 451 statements (154 anon, 149 authenticated,
--       148 service_role) including 2 views. Generated from
--       has_table_privilege() on both catalogs (relkind r,v,m), 2026-10-12.
--   §3  Verification — confirms user-reported tables are fixed
--
-- Excluded from this file:
--   - Function grants (production has ALTER DEFAULT PRIVILEGES ... ON
--     FUNCTIONS granting EXECUTE to all roles — excluded per P0 security
--     review: 266 SECURITY DEFINER functions in public; blanket EXECUTE
--     would expose financial RPCs like claim_payout_for_transfer to anon)
--   - TRUNCATE, REFERENCES, TRIGGER on existing relations (see above)
--   - 3 cron-schema defaults (supabase_admin-internal, postgres-only)
--   - 8 staging-only tables not on production
--
-- Over-grants (staging has but production lacks): NONE (0 entries)

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════
-- §1  ALTER DEFAULT PRIVILEGES — root cause fix (tables + sequences only)
-- ══════════════════════════════════════════════════════════════════════════
--
-- Production has 6 entries for public schema that staging lacks.
-- We emit 2 (tables + sequences for postgres role).
-- The remaining 4 are either functions (excluded, P0) or supabase_admin
-- (requires superuser — flagged for Owner to apply separately).
--
-- Note: GRANT ALL ON TABLES includes TRUNCATE/REFERENCES/TRIGGER, matching
-- production's defaults exactly. This applies only to future tables.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- §2  Exact GRANT diff — 451 statements (tables + views)
-- ══════════════════════════════════════════════════════════════════════════
-- Each statement adds only the specific S/I/U/D privileges present on
-- production but missing on staging. GRANT is idempotent.
-- No REVOKE statements. No blanket GRANT ALL ON ALL TABLES.
-- Covers relkind r (tables) and v (views).
--
-- Source: has_table_privilege() on both databases, 2026-10-12.

-- anon grants (154 relations)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_audit_logs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_broadcasts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_impersonation_tokens TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_role_permissions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_classification_log TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_conversation_config TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_usage TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.alerts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_keys TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.attendance_log TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.audit_log TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.blocked_phones TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.booking_confirmation_intents TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.booking_slots TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bookings TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_rules TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_sequence_enrollments TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_sequence_steps TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_sequences TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_step_overrides TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.broadcast_usage TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_bank_accounts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_broadcasts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_documents TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_faq TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_locations TO anon;
GRANT SELECT ON TABLE public.business_members TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_payment_credentials TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_payouts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_staff TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.campaign_donations TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.campaigns TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.canned_responses TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.catalog_sync_logs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.category_definitions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.category_templates TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_conversations TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_forward_usage TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_messages TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contract_signers TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contract_templates TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contracts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.conversation_usage TO anon;
GRANT INSERT, UPDATE, DELETE ON TABLE public.countries TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_consents TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_feedback TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_profiles TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_reports TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_subscriptions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.daily_summary_log TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.delivery_zones TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.demo_requests TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_invites TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_ticket_types TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_tickets TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.events TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_dropoffs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_execution_aggregates TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_execution_summaries TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.form_responses TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.forms TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fraud_events TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_campaign_recipients TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_campaigns TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_contacts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_credit_transactions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_credits TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_imports TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_pricing TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.impersonation_logs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoice_items TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoice_payment_applications TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoices TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.keyword_campaign_responses TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.keyword_campaigns TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.launch_delivery_confirmations TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.launch_subscribers TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.llm_classifications TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.loyalty_points TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.loyalty_transactions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.membership_tiers TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.message_send_attempts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messaging_opt_outs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messaging_suspension_audit TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notifications TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_spend_applications TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_stock_applications TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_tracking_notifications TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.package_enrollments TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.package_redemptions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.parties TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_confirmation_deliveries TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_links TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_spend_applications TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_accounts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_adjustments TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_terms_acceptance TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.paystack_billing_attempts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pending_transfers TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_config_versions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_fee_invoices TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_fees TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.poll_votes TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.polls TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_addons TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_campaign_codes TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_campaigns TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_code_batches TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_codes TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_eligibility_acks TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_fulfillment_notification_intents TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_pending_eligibility TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_pickup_verifications TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_prizes TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_redemptions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_reservations TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_verification_attempts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_winner_contacts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.properties TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.property_blocked_dates TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.queue_entries TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.queue_reopen_subscriptions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_requests TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.recurring_setup_intents TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.referrals TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.refund_requests TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reseller_invoices TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reseller_payouts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.resellers TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reservations TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.saved_payment_methods TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.security_events TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.security_sessions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.service_addons TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.service_packages TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.signed_waivers TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.site_pages TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stripe_recurring_finalizations TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_charges TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_checkout_intents TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_payment_quarantine TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_payments TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscriptions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_ticket_messages TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_tickets TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.survey_responses TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.surveys TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.unmatched_delivery_statuses TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.verification_requests TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.volume_discount_rules TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.waitlist_entries TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.waiver_templates TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_deliveries TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_endpoints TO anon;

-- authenticated grants (149 relations)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_audit_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_broadcasts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_impersonation_tokens TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_role_permissions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_classification_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_conversation_config TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_usage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.alerts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_keys TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.attendance_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.audit_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.blocked_phones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.booking_confirmation_intents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.booking_slots TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bookings TO authenticated;
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
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_payment_credentials TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_payouts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_staff TO authenticated;
GRANT DELETE ON TABLE public.businesses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.campaign_donations TO authenticated;
GRANT DELETE ON TABLE public.campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.canned_responses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.catalog_sync_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.category_definitions TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.category_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_forward_usage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contract_signers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contract_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contracts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.conversation_usage TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.countries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_consents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_feedback TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_reports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.daily_summary_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.demo_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_invites TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.event_tickets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_dropoffs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_execution_aggregates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_execution_summaries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.form_responses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.forms TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fraud_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_campaign_recipients TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_contacts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_credit_transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_credits TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_imports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_pricing TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.impersonation_logs TO authenticated;
GRANT UPDATE ON TABLE public.invoice_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoice_payment_applications TO authenticated;
GRANT DELETE ON TABLE public.invoices TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.keyword_campaign_responses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.keyword_campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.launch_delivery_confirmations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.launch_subscribers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.llm_classifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.loyalty_points TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.loyalty_transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.membership_tiers TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.message_send_attempts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messaging_opt_outs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messaging_suspension_audit TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_spend_applications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_stock_applications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_tracking_notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.package_enrollments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.package_redemptions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_confirmation_deliveries TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.payment_links TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_spend_applications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_adjustments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_terms_acceptance TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.paystack_billing_attempts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pending_transfers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_config_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_fee_invoices TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_fees TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.poll_votes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_addons TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_campaign_codes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_code_batches TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.promo_codes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_eligibility_acks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_fulfillment_notification_intents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_pending_eligibility TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_pickup_verifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_prizes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_redemptions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_reservations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_verification_attempts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_winner_contacts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.properties TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.property_blocked_dates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.queue_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.queue_reopen_subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.recurring_setup_intents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.referrals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.refund_requests TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.refunds TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reseller_invoices TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.reseller_payouts TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.resellers TO authenticated;
GRANT INSERT, DELETE ON TABLE public.reservations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.saved_payment_methods TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.security_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.security_sessions TO authenticated;
GRANT DELETE ON TABLE public.service_addons TO authenticated;
GRANT DELETE ON TABLE public.service_packages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.signed_waivers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.site_pages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stripe_recurring_finalizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_charges TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_checkout_intents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_payment_quarantine TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_payments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_ticket_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_tickets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.survey_responses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.unmatched_delivery_statuses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.verification_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.volume_discount_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.waitlist_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.waiver_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_deliveries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_endpoints TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.whatsapp_channels TO authenticated;

-- service_role grants (148 relations)
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
-- §3  VERIFICATION
-- ══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  _errors text[] := '{}';
BEGIN
  -- User-reported tables
  IF NOT has_table_privilege('authenticated', 'public.business_payouts', 'SELECT') THEN
    _errors := _errors || 'business_payouts: authenticated missing SELECT';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.payout_adjustments', 'SELECT') THEN
    _errors := _errors || 'payout_adjustments: service_role missing SELECT';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.payout_accounts', 'SELECT') THEN
    _errors := _errors || 'payout_accounts: service_role missing SELECT';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.verification_requests', 'SELECT') THEN
    _errors := _errors || 'verification_requests: service_role missing SELECT';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.business_documents', 'SELECT') THEN
    _errors := _errors || 'business_documents: service_role missing SELECT';
  END IF;
  -- Correction #1 tables
  IF NOT has_table_privilege('service_role', 'public.admin_broadcasts', 'SELECT') THEN
    _errors := _errors || 'admin_broadcasts: service_role missing SELECT';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.admin_role_permissions', 'SELECT') THEN
    _errors := _errors || 'admin_role_permissions: service_role missing SELECT';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.ai_classification_log', 'SELECT') THEN
    _errors := _errors || 'ai_classification_log: service_role missing SELECT';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.ai_usage', 'SELECT') THEN
    _errors := _errors || 'ai_usage: service_role missing SELECT';
  END IF;
  -- Views
  IF NOT has_table_privilege('service_role', 'public.businesses_public', 'SELECT') THEN
    _errors := _errors || 'businesses_public: service_role missing SELECT';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.whatsapp_channels_public', 'SELECT') THEN
    _errors := _errors || 'whatsapp_channels_public: service_role missing SELECT';
  END IF;

  IF array_length(_errors, 1) > 0 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED — rolling back: %', array_to_string(_errors, '; ');
  END IF;
  RAISE NOTICE 'Grants reconciliation: all verification checks passed.';
END $$;

COMMIT;
