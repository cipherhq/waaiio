-- =============================================================
-- final_acl_repair.sql
-- Staging ACL repair — delta from current state to target state
-- Generated: 2026-09-25
-- =============================================================

BEGIN;

-- ============================================================
-- PRECONDITIONS
-- ============================================================

DO $$
DECLARE
  v_table_count   integer;
  v_svc_grant_cnt integer;
  v_seq_count     integer;
  v_dacl_count    integer;
BEGIN
  -- Check table count = 197
  SELECT count(*) INTO v_table_count
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_type = 'BASE TABLE';
  IF v_table_count <> 197 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected 197 public tables, got %', v_table_count;
  END IF;

  -- Check service_role grant count on tables = 30
  SELECT count(DISTINCT table_name) INTO v_svc_grant_cnt
    FROM information_schema.role_table_grants
   WHERE grantee = 'service_role'
     AND table_schema = 'public';
  IF v_svc_grant_cnt <> 30 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected 30 service_role granted tables, got %', v_svc_grant_cnt;
  END IF;

  -- Check sequence count = 0
  SELECT count(*) INTO v_seq_count
    FROM information_schema.sequences
   WHERE sequence_schema = 'public';
  IF v_seq_count <> 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected 0 public sequences, got %', v_seq_count;
  END IF;

  -- Check default ACL count = 0
  SELECT count(*) INTO v_dacl_count
    FROM pg_default_acl da
    JOIN pg_namespace n ON n.oid = da.defaclnamespace
   WHERE n.nspname = 'public';
  IF v_dacl_count <> 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: expected 0 default ACLs in public schema, got %', v_dacl_count;
  END IF;

  RAISE NOTICE 'PRECONDITIONS PASSED: tables=%, svc_granted_tables=%, sequences=%, default_acls=%',
    v_table_count, v_svc_grant_cnt, v_seq_count, v_dacl_count;
END $$;

-- ============================================================
-- PART 1: ALTER DEFAULT PRIVILEGES (6 statements)
-- ============================================================

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- ============================================================
-- PART 2: TABLE GRANTS (delta only)
-- ============================================================

-- GRANT ALL TO anon (165 tables)
GRANT ALL ON
    public.admin_audit_logs,
    public.admin_broadcasts,
    public.admin_impersonation_tokens,
    public.admin_role_permissions,
    public.ai_classification_log,
    public.ai_conversation_config,
    public.ai_usage,
    public.alerts,
    public.api_keys,
    public.appointments
  TO anon;
GRANT ALL ON
    public.attendance_log,
    public.audit_log,
    public.blocked_phones,
    public.booking_confirmation_intents,
    public.booking_slots,
    public.bookings,
    public.bot_rules,
    public.bot_sequence_enrollments,
    public.bot_sequence_steps,
    public.bot_sequences
  TO anon;
GRANT ALL ON
    public.bot_sessions,
    public.bot_step_overrides,
    public.broadcast_usage,
    public.business_bank_accounts,
    public.business_broadcasts,
    public.business_capabilities,
    public.business_documents,
    public.business_faq,
    public.business_locations,
    public.business_members
  TO anon;
GRANT ALL ON
    public.business_payouts,
    public.business_staff,
    public.campaign_donations,
    public.campaigns,
    public.canned_responses,
    public.capability_overrides,
    public.catalog_sync_logs,
    public.category_definitions,
    public.category_templates,
    public.chat_conversations
  TO anon;
GRANT ALL ON
    public.chat_forward_usage,
    public.chat_messages,
    public.contract_signers,
    public.contract_templates,
    public.contracts,
    public.conversation_usage,
    public.countries,
    public.customer_consents,
    public.customer_feedback,
    public.customer_profiles
  TO anon;
GRANT ALL ON
    public.customer_reports,
    public.customer_subscriptions,
    public.daily_summary_log,
    public.delivery_zones,
    public.demo_requests,
    public.event_invites,
    public.event_ticket_types,
    public.event_tickets,
    public.events,
    public.flow_dropoffs
  TO anon;
GRANT ALL ON
    public.flow_execution_aggregates,
    public.flow_execution_summaries,
    public.form_responses,
    public.forms,
    public.fraud_events,
    public.growth_campaign_recipients,
    public.growth_campaigns,
    public.growth_contacts,
    public.growth_credit_transactions,
    public.growth_credits
  TO anon;
GRANT ALL ON
    public.growth_imports,
    public.growth_pricing,
    public.impersonation_logs,
    public.invoice_items,
    public.invoice_payment_applications,
    public.invoices,
    public.keyword_campaign_responses,
    public.keyword_campaigns,
    public.launch_delivery_confirmations,
    public.launch_subscribers
  TO anon;
GRANT ALL ON
    public.llm_classifications,
    public.loyalty_points,
    public.loyalty_transactions,
    public.membership_tiers,
    public.message_send_attempts,
    public.messaging_opt_outs,
    public.messaging_suspension_audit,
    public.notifications,
    public.order_items,
    public.order_spend_applications
  TO anon;
GRANT ALL ON
    public.order_stock_applications,
    public.order_tracking_notifications,
    public.orders,
    public.package_enrollments,
    public.package_redemptions,
    public.parties,
    public.payment_confirmation_deliveries,
    public.payment_links,
    public.payment_spend_applications,
    public.payments
  TO anon;
GRANT ALL ON
    public.payout_accounts,
    public.payout_adjustments,
    public.payout_terms_acceptance,
    public.paystack_billing_attempts,
    public.pending_transfers,
    public.platform_config_versions,
    public.platform_fee_invoices,
    public.platform_fees,
    public.platform_settings,
    public.poll_votes
  TO anon;
GRANT ALL ON
    public.polls,
    public.product_addons,
    public.product_variants,
    public.products,
    public.promo_campaign_codes,
    public.promo_campaigns,
    public.promo_code_batches,
    public.promo_codes,
    public.promo_eligibility_acks,
    public.promo_fulfillment_notification_intents
  TO anon;
GRANT ALL ON
    public.promo_pending_eligibility,
    public.promo_pickup_verifications,
    public.promo_prizes,
    public.promo_redemptions,
    public.promo_reservations,
    public.promo_verification_attempts,
    public.promo_winner_contacts,
    public.properties,
    public.property_blocked_dates,
    public.queue_entries
  TO anon;
GRANT ALL ON
    public.queue_reopen_subscriptions,
    public.quote_requests,
    public.recurring_setup_intents,
    public.referrals,
    public.refund_requests,
    public.reseller_invoices,
    public.reseller_payouts,
    public.resellers,
    public.reservations,
    public.saved_payment_methods
  TO anon;
GRANT ALL ON
    public.security_events,
    public.security_sessions,
    public.service_addons,
    public.service_packages,
    public.services,
    public.signed_waivers,
    public.site_pages,
    public.stripe_recurring_finalizations,
    public.subscription_charges,
    public.subscription_checkout_intents
  TO anon;
GRANT ALL ON
    public.subscription_payment_quarantine,
    public.subscription_payments,
    public.subscriptions,
    public.support_ticket_messages,
    public.support_tickets,
    public.survey_responses,
    public.surveys,
    public.unmatched_delivery_statuses,
    public.verification_requests,
    public.volume_discount_rules
  TO anon;
GRANT ALL ON
    public.waitlist_entries,
    public.waiver_templates,
    public.webhook_deliveries,
    public.webhook_endpoints,
    public.whatsapp_config
  TO anon;

-- GRANT ALL TO authenticated (162 tables)
GRANT ALL ON
    public.admin_audit_logs,
    public.admin_broadcasts,
    public.admin_impersonation_tokens,
    public.admin_role_permissions,
    public.ai_classification_log,
    public.ai_conversation_config,
    public.ai_usage,
    public.alerts,
    public.api_keys,
    public.appointments
  TO authenticated;
GRANT ALL ON
    public.attendance_log,
    public.audit_log,
    public.blocked_phones,
    public.booking_confirmation_intents,
    public.booking_slots,
    public.bookings,
    public.bot_rules,
    public.bot_sequence_enrollments,
    public.bot_sequence_steps,
    public.bot_sequences
  TO authenticated;
GRANT ALL ON
    public.bot_sessions,
    public.bot_step_overrides,
    public.broadcast_usage,
    public.business_bank_accounts,
    public.business_broadcasts,
    public.business_capabilities,
    public.business_documents,
    public.business_faq,
    public.business_locations,
    public.business_members
  TO authenticated;
GRANT ALL ON
    public.business_payouts,
    public.business_staff,
    public.campaign_donations,
    public.campaigns,
    public.canned_responses,
    public.capability_overrides,
    public.catalog_sync_logs,
    public.category_definitions,
    public.category_templates,
    public.chat_conversations
  TO authenticated;
GRANT ALL ON
    public.chat_forward_usage,
    public.chat_messages,
    public.contract_signers,
    public.contract_templates,
    public.contracts,
    public.conversation_usage,
    public.countries,
    public.customer_consents,
    public.customer_feedback,
    public.customer_profiles
  TO authenticated;
GRANT ALL ON
    public.customer_reports,
    public.customer_subscriptions,
    public.daily_summary_log,
    public.delivery_zones,
    public.demo_requests,
    public.event_invites,
    public.event_ticket_types,
    public.event_tickets,
    public.events,
    public.flow_dropoffs
  TO authenticated;
GRANT ALL ON
    public.flow_execution_aggregates,
    public.flow_execution_summaries,
    public.form_responses,
    public.forms,
    public.fraud_events,
    public.growth_campaign_recipients,
    public.growth_campaigns,
    public.growth_contacts,
    public.growth_credit_transactions,
    public.growth_credits
  TO authenticated;
GRANT ALL ON
    public.growth_imports,
    public.growth_pricing,
    public.impersonation_logs,
    public.invoice_items,
    public.invoice_payment_applications,
    public.invoices,
    public.keyword_campaign_responses,
    public.keyword_campaigns,
    public.launch_delivery_confirmations,
    public.launch_subscribers
  TO authenticated;
GRANT ALL ON
    public.llm_classifications,
    public.loyalty_points,
    public.loyalty_transactions,
    public.membership_tiers,
    public.messaging_opt_outs,
    public.messaging_suspension_audit,
    public.notifications,
    public.order_items,
    public.order_spend_applications,
    public.order_stock_applications
  TO authenticated;
GRANT ALL ON
    public.order_tracking_notifications,
    public.orders,
    public.package_enrollments,
    public.package_redemptions,
    public.parties,
    public.payment_confirmation_deliveries,
    public.payment_links,
    public.payment_spend_applications,
    public.payments,
    public.payout_accounts
  TO authenticated;
GRANT ALL ON
    public.payout_adjustments,
    public.payout_terms_acceptance,
    public.paystack_billing_attempts,
    public.pending_transfers,
    public.platform_config_versions,
    public.platform_fee_invoices,
    public.platform_fees,
    public.platform_settings,
    public.poll_votes,
    public.polls
  TO authenticated;
GRANT ALL ON
    public.product_addons,
    public.product_variants,
    public.products,
    public.promo_campaign_codes,
    public.promo_campaigns,
    public.promo_code_batches,
    public.promo_codes,
    public.promo_eligibility_acks,
    public.promo_fulfillment_notification_intents,
    public.promo_pending_eligibility
  TO authenticated;
GRANT ALL ON
    public.promo_pickup_verifications,
    public.promo_prizes,
    public.promo_redemptions,
    public.promo_reservations,
    public.promo_verification_attempts,
    public.promo_winner_contacts,
    public.properties,
    public.property_blocked_dates,
    public.queue_entries,
    public.queue_reopen_subscriptions
  TO authenticated;
GRANT ALL ON
    public.quote_requests,
    public.recurring_setup_intents,
    public.referrals,
    public.refund_requests,
    public.reseller_invoices,
    public.reservations,
    public.saved_payment_methods,
    public.security_events,
    public.security_sessions,
    public.service_addons
  TO authenticated;
GRANT ALL ON
    public.service_packages,
    public.services,
    public.signed_waivers,
    public.site_pages,
    public.stripe_recurring_finalizations,
    public.subscription_charges,
    public.subscription_checkout_intents,
    public.subscription_payment_quarantine,
    public.subscription_payments,
    public.subscriptions
  TO authenticated;
GRANT ALL ON
    public.support_ticket_messages,
    public.support_tickets,
    public.survey_responses,
    public.surveys,
    public.unmatched_delivery_statuses,
    public.verification_requests,
    public.volume_discount_rules,
    public.waitlist_entries,
    public.waiver_templates,
    public.webhook_deliveries
  TO authenticated;
GRANT ALL ON
    public.webhook_endpoints,
    public.whatsapp_config
  TO authenticated;

-- GRANT DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE TO authenticated (5 tables)
GRANT DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE ON
    public.bot_keywords,
    public.message_send_attempts,
    public.refunds,
    public.resellers,
    public.whatsapp_channels
  TO authenticated;

-- GRANT DELETE, REFERENCES, TRIGGER, TRUNCATE TO authenticated (1 tables)
GRANT DELETE, REFERENCES, TRIGGER, TRUNCATE ON
    public.businesses
  TO authenticated;

-- GRANT REFERENCES, TRIGGER, TRUNCATE TO authenticated (1 tables)
GRANT REFERENCES, TRIGGER, TRUNCATE ON
    public.reseller_payouts
  TO authenticated;

-- GRANT ALL TO service_role (167 tables)
GRANT ALL ON
    public.admin_audit_logs,
    public.admin_broadcasts,
    public.admin_impersonation_tokens,
    public.admin_role_permissions,
    public.ai_classification_log,
    public.ai_conversation_config,
    public.ai_usage,
    public.alerts,
    public.api_keys,
    public.appointments
  TO service_role;
GRANT ALL ON
    public.attendance_log,
    public.audit_log,
    public.blocked_phones,
    public.booking_confirmation_intents,
    public.booking_slots,
    public.bookings,
    public.bot_rules,
    public.bot_sequence_enrollments,
    public.bot_sequence_steps,
    public.bot_sequences
  TO service_role;
GRANT ALL ON
    public.bot_sessions,
    public.bot_step_overrides,
    public.broadcast_usage,
    public.business_bank_accounts,
    public.business_broadcasts,
    public.business_capabilities,
    public.business_documents,
    public.business_faq,
    public.business_locations,
    public.business_members
  TO service_role;
GRANT ALL ON
    public.business_payouts,
    public.business_staff,
    public.campaign_donations,
    public.campaigns,
    public.canned_responses,
    public.capability_overrides,
    public.catalog_sync_logs,
    public.category_definitions,
    public.category_templates,
    public.chat_conversations
  TO service_role;
GRANT ALL ON
    public.chat_forward_usage,
    public.chat_messages,
    public.contract_signers,
    public.contract_templates,
    public.contracts,
    public.conversation_usage,
    public.countries,
    public.customer_consents,
    public.customer_feedback,
    public.customer_profiles
  TO service_role;
GRANT ALL ON
    public.customer_reports,
    public.customer_subscriptions,
    public.daily_summary_log,
    public.delivery_zones,
    public.demo_requests,
    public.event_invites,
    public.event_ticket_types,
    public.event_tickets,
    public.events,
    public.flow_dropoffs
  TO service_role;
GRANT ALL ON
    public.flow_execution_aggregates,
    public.flow_execution_summaries,
    public.form_responses,
    public.forms,
    public.fraud_events,
    public.growth_campaign_recipients,
    public.growth_campaigns,
    public.growth_contacts,
    public.growth_credit_transactions,
    public.growth_credits
  TO service_role;
GRANT ALL ON
    public.growth_imports,
    public.growth_pricing,
    public.impersonation_logs,
    public.invoice_items,
    public.invoice_payment_applications,
    public.invoices,
    public.keyword_campaign_responses,
    public.keyword_campaigns,
    public.launch_delivery_confirmations,
    public.launch_subscribers
  TO service_role;
GRANT ALL ON
    public.llm_classifications,
    public.loyalty_points,
    public.loyalty_transactions,
    public.membership_tiers,
    public.messaging_opt_outs,
    public.messaging_suspension_audit,
    public.notifications,
    public.order_items,
    public.order_spend_applications,
    public.order_stock_applications
  TO service_role;
GRANT ALL ON
    public.order_tracking_notifications,
    public.orders,
    public.package_enrollments,
    public.package_redemptions,
    public.parties,
    public.payment_confirmation_deliveries,
    public.payment_links,
    public.payment_spend_applications,
    public.payment_visit_applications,
    public.payments
  TO service_role;
GRANT ALL ON
    public.payout_accounts,
    public.payout_adjustments,
    public.payout_terms_acceptance,
    public.paystack_billing_attempts,
    public.pending_transfers,
    public.platform_config_versions,
    public.platform_fee_invoices,
    public.platform_fees,
    public.platform_settings,
    public.poll_votes
  TO service_role;
GRANT ALL ON
    public.polls,
    public.product_addons,
    public.product_variants,
    public.products,
    public.promo_campaign_codes,
    public.promo_campaigns,
    public.promo_code_batches,
    public.promo_codes,
    public.promo_eligibility_acks,
    public.promo_fulfillment_notification_intents
  TO service_role;
GRANT ALL ON
    public.promo_pending_eligibility,
    public.promo_prizes,
    public.promo_redemptions,
    public.promo_reservations,
    public.promo_verification_attempts,
    public.promo_winner_contacts,
    public.properties,
    public.property_blocked_dates,
    public.provider_cleanup_operations,
    public.provider_customer_identities
  TO service_role;
GRANT ALL ON
    public.queue_entries,
    public.queue_reopen_subscriptions,
    public.quote_requests,
    public.recurring_setup_intents,
    public.referrals,
    public.refund_requests,
    public.reseller_invoices,
    public.reseller_payouts,
    public.resellers,
    public.reservations
  TO service_role;
GRANT ALL ON
    public.saved_card_auth_attempts,
    public.saved_payment_methods,
    public.security_events,
    public.security_sessions,
    public.service_addons,
    public.service_packages,
    public.services,
    public.signed_waivers,
    public.site_pages,
    public.stripe_recurring_finalizations
  TO service_role;
GRANT ALL ON
    public.subscription_charges,
    public.subscription_checkout_intents,
    public.subscription_payment_quarantine,
    public.subscription_payments,
    public.subscriptions,
    public.support_ticket_messages,
    public.support_tickets,
    public.survey_responses,
    public.surveys,
    public.unmatched_delivery_statuses
  TO service_role;
GRANT ALL ON
    public.verification_requests,
    public.volume_discount_rules,
    public.waitlist_entries,
    public.waiver_templates,
    public.webhook_deliveries,
    public.webhook_endpoints,
    public.whatsapp_config
  TO service_role;

-- GRANT DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE TO service_role (1 tables)
GRANT DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE ON
    public.bot_keywords
  TO service_role;

-- GRANT DELETE, REFERENCES, TRIGGER, TRUNCATE TO service_role (1 tables)
GRANT DELETE, REFERENCES, TRIGGER, TRUNCATE ON
    public.message_send_attempts
  TO service_role;

-- GRANT REFERENCES, TRIGGER, TRUNCATE TO service_role (2 tables)
GRANT REFERENCES, TRIGGER, TRUNCATE ON
    public.processed_webhook_events,
    public.whatsapp_channels
  TO service_role;

-- ============================================================
-- PART 3: ROUTINE EXECUTE GRANTS (delta only)
-- 807 grants to add
-- ============================================================

-- Grants to anon (270 routines)
GRANT EXECUTE ON FUNCTION public.calculate_volume_discount(p_business_id uuid, p_product_id uuid, p_quantity integer, p_unit_price integer) TO anon;
GRANT EXECUTE ON FUNCTION public.cash_dist(money, money) TO anon;
GRANT EXECUTE ON FUNCTION public.check_business_role(p_user_id uuid, p_business_id uuid, p_required_roles business_role[]) TO anon;
GRANT EXECUTE ON FUNCTION public.check_conversation_limit(p_business_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.claim_launch_delivery(p_subscriber_id uuid, p_campaign_version text) TO anon;
GRANT EXECUTE ON FUNCTION public.complete_launch_delivery(p_subscriber_id uuid, p_claim_token uuid, p_status text, p_message_id text, p_error text) TO anon;
GRANT EXECUTE ON FUNCTION public.consume_launch_confirmation(p_token uuid, p_admin_id uuid, p_campaign_version text) TO anon;
GRANT EXECUTE ON FUNCTION public.consume_launch_confirmation(p_token uuid, p_admin_id uuid, p_campaign_version text, p_retry_only boolean, p_send_limit integer) TO anon;
GRANT EXECUTE ON FUNCTION public.date_dist(date, date) TO anon;
GRANT EXECUTE ON FUNCTION public.enforce_attempt_status_transitions() TO anon;
GRANT EXECUTE ON FUNCTION public.enforce_disposition_transitions() TO anon;
GRANT EXECUTE ON FUNCTION public.enforce_spend_period_provenance_immutability() TO anon;
GRANT EXECUTE ON FUNCTION public.enforce_wamid_immutability() TO anon;
GRANT EXECUTE ON FUNCTION public.float4_dist(real, real) TO anon;
GRANT EXECUTE ON FUNCTION public.float8_dist(double precision, double precision) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bit_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bit_consistent(internal, bit, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bit_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bit_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bit_same(gbtreekey_var, gbtreekey_var, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bit_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bool_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bool_consistent(internal, boolean, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bool_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bool_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bool_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bool_same(gbtreekey2, gbtreekey2, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bool_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bpchar_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bpchar_consistent(internal, character, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_consistent(internal, bytea, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_same(gbtreekey_var, gbtreekey_var, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_cash_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_cash_consistent(internal, money, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_cash_distance(internal, money, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_cash_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_cash_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_cash_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_cash_same(gbtreekey16, gbtreekey16, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_cash_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_date_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_date_consistent(internal, date, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_date_distance(internal, date, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_date_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_date_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_date_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_date_same(gbtreekey8, gbtreekey8, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_date_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_decompress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_enum_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_enum_consistent(internal, anyenum, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_enum_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_enum_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_enum_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_enum_same(gbtreekey8, gbtreekey8, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_enum_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float4_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float4_consistent(internal, real, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float4_distance(internal, real, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float4_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float4_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float4_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float4_same(gbtreekey8, gbtreekey8, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float4_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float8_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float8_consistent(internal, double precision, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float8_distance(internal, double precision, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float8_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float8_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float8_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float8_same(gbtreekey16, gbtreekey16, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_float8_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_inet_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_inet_consistent(internal, inet, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_inet_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_inet_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_inet_same(gbtreekey16, gbtreekey16, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_inet_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int2_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int2_consistent(internal, smallint, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int2_distance(internal, smallint, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int2_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int2_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int2_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int2_same(gbtreekey4, gbtreekey4, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int2_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int4_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int4_consistent(internal, integer, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int4_distance(internal, integer, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int4_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int4_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int4_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int4_same(gbtreekey8, gbtreekey8, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int4_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int8_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int8_consistent(internal, bigint, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int8_distance(internal, bigint, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int8_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int8_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int8_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int8_same(gbtreekey16, gbtreekey16, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_int8_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_intv_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_intv_consistent(internal, interval, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_intv_decompress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_intv_distance(internal, interval, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_intv_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_intv_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_intv_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_intv_same(gbtreekey32, gbtreekey32, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_intv_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_same(gbtreekey16, gbtreekey16, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad_consistent(internal, macaddr, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad_same(gbtreekey16, gbtreekey16, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_macad_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_consistent(internal, numeric, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_same(gbtreekey_var, gbtreekey_var, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_oid_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_oid_consistent(internal, oid, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_oid_distance(internal, oid, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_oid_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_oid_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_oid_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_oid_same(gbtreekey8, gbtreekey8, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_oid_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_text_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_text_consistent(internal, text, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_text_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_text_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_text_same(gbtreekey_var, gbtreekey_var, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_text_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_time_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_time_consistent(internal, time without time zone, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_time_distance(internal, time without time zone, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_time_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_time_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_time_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_time_same(gbtreekey16, gbtreekey16, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_time_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_timetz_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_ts_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_ts_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_ts_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_ts_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_ts_same(gbtreekey16, gbtreekey16, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_ts_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_tstz_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_consistent(internal, uuid, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_same(gbtreekey32, gbtreekey32, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_var_decompress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbt_var_fetch(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gbtreekey16_in(cstring) TO anon;
GRANT EXECUTE ON FUNCTION public.gbtreekey16_out(gbtreekey16) TO anon;
GRANT EXECUTE ON FUNCTION public.gbtreekey2_in(cstring) TO anon;
GRANT EXECUTE ON FUNCTION public.gbtreekey2_out(gbtreekey2) TO anon;
GRANT EXECUTE ON FUNCTION public.gbtreekey32_in(cstring) TO anon;
GRANT EXECUTE ON FUNCTION public.gbtreekey32_out(gbtreekey32) TO anon;
GRANT EXECUTE ON FUNCTION public.gbtreekey4_in(cstring) TO anon;
GRANT EXECUTE ON FUNCTION public.gbtreekey4_out(gbtreekey4) TO anon;
GRANT EXECUTE ON FUNCTION public.gbtreekey8_in(cstring) TO anon;
GRANT EXECUTE ON FUNCTION public.gbtreekey8_out(gbtreekey8) TO anon;
GRANT EXECUTE ON FUNCTION public.gbtreekey_var_in(cstring) TO anon;
GRANT EXECUTE ON FUNCTION public.gbtreekey_var_out(gbtreekey_var) TO anon;
GRANT EXECUTE ON FUNCTION public.generate_event_slug() TO anon;
GRANT EXECUTE ON FUNCTION public.generate_invoice_reference() TO anon;
GRANT EXECUTE ON FUNCTION public.generate_order_reference() TO anon;
GRANT EXECUTE ON FUNCTION public.generate_reference_code() TO anon;
GRANT EXECUTE ON FUNCTION public.generate_reservation_reference() TO anon;
GRANT EXECUTE ON FUNCTION public.get_business_revenue(p_business_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_effective_config(p_at timestamp with time zone) TO anon;
GRANT EXECUTE ON FUNCTION public.get_order_revenue(p_business_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_outstanding_invoices(p_business_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gin_extract_value_trgm(text, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gtrgm_compress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gtrgm_consistent(internal, text, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gtrgm_decompress(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gtrgm_distance(internal, text, smallint, oid, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gtrgm_in(cstring) TO anon;
GRANT EXECUTE ON FUNCTION public.gtrgm_options(internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gtrgm_out(gtrgm) TO anon;
GRANT EXECUTE ON FUNCTION public.gtrgm_penalty(internal, internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gtrgm_picksplit(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gtrgm_same(gtrgm, gtrgm, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.gtrgm_union(internal, internal) TO anon;
GRANT EXECUTE ON FUNCTION public.guard_commercial_settings() TO anon;
GRANT EXECUTE ON FUNCTION public.guard_config_version_insert() TO anon;
GRANT EXECUTE ON FUNCTION public.guard_country_activation() TO anon;
GRANT EXECUTE ON FUNCTION public.guard_country_deletion() TO anon;
GRANT EXECUTE ON FUNCTION public.guard_fee_policy_immutability() TO anon;
GRANT EXECUTE ON FUNCTION public.guard_messaging_suspended() TO anon;
GRANT EXECUTE ON FUNCTION public.guard_paystack_plan_code_authority() TO anon;
GRANT EXECUTE ON FUNCTION public.guard_prize_instructions_integrity() TO anon;
GRANT EXECUTE ON FUNCTION public.guard_provider_ref_authority() TO anon;
GRANT EXECUTE ON FUNCTION public.guard_sending_requires_valid_reservation() TO anon;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO anon;
GRANT EXECUTE ON FUNCTION public.handle_site_pages_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.int2_dist(smallint, smallint) TO anon;
GRANT EXECUTE ON FUNCTION public.int4_dist(integer, integer) TO anon;
GRANT EXECUTE ON FUNCTION public.int8_dist(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.interval_dist(interval, interval) TO anon;
GRANT EXECUTE ON FUNCTION public.next_queue_number(biz_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.normalize_promo_keyword() TO anon;
GRANT EXECUTE ON FUNCTION public.oid_dist(oid, oid) TO anon;
GRANT EXECUTE ON FUNCTION public.prevent_allowance_event_mutation() TO anon;
GRANT EXECUTE ON FUNCTION public.prevent_config_version_mutation() TO anon;
GRANT EXECUTE ON FUNCTION public.prevent_cost_event_mutation() TO anon;
GRANT EXECUTE ON FUNCTION public.prevent_reconciliation_log_mutation() TO anon;
GRANT EXECUTE ON FUNCTION public.prevent_snapshot_version_downgrade() TO anon;
GRANT EXECUTE ON FUNCTION public.prevent_suspension_audit_mutation() TO anon;
GRANT EXECUTE ON FUNCTION public.prevent_tier_tampering() TO anon;
GRANT EXECUTE ON FUNCTION public.set_limit(real) TO anon;
GRANT EXECUTE ON FUNCTION public.show_limit() TO anon;
GRANT EXECUTE ON FUNCTION public.show_trgm(text) TO anon;
GRANT EXECUTE ON FUNCTION public.similarity(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.similarity_dist(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.similarity_op(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity_commutator_op(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity_dist_commutator_op(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity_dist_op(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity_op(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.sync_service_status_to_is_active() TO anon;
GRANT EXECUTE ON FUNCTION public.time_dist(time without time zone, time without time zone) TO anon;
GRANT EXECUTE ON FUNCTION public.ts_dist(timestamp without time zone, timestamp without time zone) TO anon;
GRANT EXECUTE ON FUNCTION public.tstz_dist(timestamp with time zone, timestamp with time zone) TO anon;
GRANT EXECUTE ON FUNCTION public.update_business_rating() TO anon;
GRANT EXECUTE ON FUNCTION public.update_countries_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.update_customer_subscriptions_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.update_last_active_on_deactivate() TO anon;
GRANT EXECUTE ON FUNCTION public.update_promo_campaign_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.validate_allowance_event_tenant() TO anon;
GRANT EXECUTE ON FUNCTION public.validate_fee_basis() TO anon;
GRANT EXECUTE ON FUNCTION public.validate_promo_campaign_status_transition() TO anon;
GRANT EXECUTE ON FUNCTION public.word_similarity(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.word_similarity_commutator_op(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.word_similarity_dist_commutator_op(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.word_similarity_dist_op(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.word_similarity_op(text, text) TO anon;

-- Grants to authenticated (267 routines)
GRANT EXECUTE ON FUNCTION public.calculate_volume_discount(p_business_id uuid, p_product_id uuid, p_quantity integer, p_unit_price integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cash_dist(money, money) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_business_role(p_user_id uuid, p_business_id uuid, p_required_roles business_role[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_conversation_limit(p_business_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_launch_delivery(p_subscriber_id uuid, p_campaign_version text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_launch_delivery(p_subscriber_id uuid, p_claim_token uuid, p_status text, p_message_id text, p_error text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_launch_confirmation(p_token uuid, p_admin_id uuid, p_campaign_version text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_launch_confirmation(p_token uuid, p_admin_id uuid, p_campaign_version text, p_retry_only boolean, p_send_limit integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.date_dist(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_attempt_status_transitions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_disposition_transitions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_spend_period_provenance_immutability() TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_wamid_immutability() TO authenticated;
GRANT EXECUTE ON FUNCTION public.float4_dist(real, real) TO authenticated;
GRANT EXECUTE ON FUNCTION public.float8_dist(double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bit_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bit_consistent(internal, bit, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bit_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bit_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bit_same(gbtreekey_var, gbtreekey_var, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bit_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bool_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bool_consistent(internal, boolean, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bool_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bool_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bool_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bool_same(gbtreekey2, gbtreekey2, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bool_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bpchar_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bpchar_consistent(internal, character, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_consistent(internal, bytea, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_same(gbtreekey_var, gbtreekey_var, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_cash_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_cash_consistent(internal, money, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_cash_distance(internal, money, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_cash_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_cash_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_cash_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_cash_same(gbtreekey16, gbtreekey16, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_cash_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_date_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_date_consistent(internal, date, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_date_distance(internal, date, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_date_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_date_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_date_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_date_same(gbtreekey8, gbtreekey8, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_date_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_decompress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_enum_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_enum_consistent(internal, anyenum, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_enum_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_enum_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_enum_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_enum_same(gbtreekey8, gbtreekey8, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_enum_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float4_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float4_consistent(internal, real, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float4_distance(internal, real, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float4_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float4_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float4_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float4_same(gbtreekey8, gbtreekey8, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float4_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float8_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float8_consistent(internal, double precision, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float8_distance(internal, double precision, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float8_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float8_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float8_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float8_same(gbtreekey16, gbtreekey16, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_float8_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_inet_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_inet_consistent(internal, inet, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_inet_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_inet_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_inet_same(gbtreekey16, gbtreekey16, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_inet_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int2_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int2_consistent(internal, smallint, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int2_distance(internal, smallint, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int2_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int2_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int2_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int2_same(gbtreekey4, gbtreekey4, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int2_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int4_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int4_consistent(internal, integer, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int4_distance(internal, integer, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int4_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int4_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int4_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int4_same(gbtreekey8, gbtreekey8, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int4_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int8_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int8_consistent(internal, bigint, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int8_distance(internal, bigint, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int8_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int8_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int8_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int8_same(gbtreekey16, gbtreekey16, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_int8_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_intv_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_intv_consistent(internal, interval, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_intv_decompress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_intv_distance(internal, interval, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_intv_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_intv_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_intv_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_intv_same(gbtreekey32, gbtreekey32, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_intv_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_same(gbtreekey16, gbtreekey16, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad_consistent(internal, macaddr, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad_same(gbtreekey16, gbtreekey16, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_macad_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_consistent(internal, numeric, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_same(gbtreekey_var, gbtreekey_var, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_oid_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_oid_consistent(internal, oid, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_oid_distance(internal, oid, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_oid_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_oid_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_oid_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_oid_same(gbtreekey8, gbtreekey8, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_oid_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_text_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_text_consistent(internal, text, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_text_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_text_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_text_same(gbtreekey_var, gbtreekey_var, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_text_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_time_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_time_consistent(internal, time without time zone, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_time_distance(internal, time without time zone, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_time_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_time_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_time_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_time_same(gbtreekey16, gbtreekey16, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_time_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_timetz_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_ts_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_ts_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_ts_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_ts_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_ts_same(gbtreekey16, gbtreekey16, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_ts_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_tstz_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_consistent(internal, uuid, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_same(gbtreekey32, gbtreekey32, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_var_decompress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbt_var_fetch(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbtreekey16_in(cstring) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbtreekey16_out(gbtreekey16) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbtreekey2_in(cstring) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbtreekey2_out(gbtreekey2) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbtreekey32_in(cstring) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbtreekey32_out(gbtreekey32) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbtreekey4_in(cstring) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbtreekey4_out(gbtreekey4) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbtreekey8_in(cstring) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbtreekey8_out(gbtreekey8) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbtreekey_var_in(cstring) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gbtreekey_var_out(gbtreekey_var) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_event_slug() TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_invoice_reference() TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_order_reference() TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_reference_code() TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_reservation_reference() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_effective_config(p_at timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gin_extract_value_trgm(text, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gtrgm_compress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gtrgm_consistent(internal, text, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gtrgm_decompress(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gtrgm_distance(internal, text, smallint, oid, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gtrgm_in(cstring) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gtrgm_options(internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gtrgm_out(gtrgm) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gtrgm_penalty(internal, internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gtrgm_picksplit(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gtrgm_same(gtrgm, gtrgm, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gtrgm_union(internal, internal) TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_commercial_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_config_version_insert() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_country_activation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_country_deletion() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_fee_policy_immutability() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_messaging_suspended() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_paystack_plan_code_authority() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_prize_instructions_integrity() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_provider_ref_authority() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_sending_requires_valid_reservation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated;
GRANT EXECUTE ON FUNCTION public.handle_site_pages_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.int2_dist(smallint, smallint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.int4_dist(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.int8_dist(bigint, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.interval_dist(interval, interval) TO authenticated;
GRANT EXECUTE ON FUNCTION public.next_queue_number(biz_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_promo_keyword() TO authenticated;
GRANT EXECUTE ON FUNCTION public.oid_dist(oid, oid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_allowance_event_mutation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_config_version_mutation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_cost_event_mutation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_reconciliation_log_mutation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_snapshot_version_downgrade() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_suspension_audit_mutation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_tier_tampering() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_limit(real) TO authenticated;
GRANT EXECUTE ON FUNCTION public.show_limit() TO authenticated;
GRANT EXECUTE ON FUNCTION public.show_trgm(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.similarity(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.similarity_dist(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.similarity_op(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity_commutator_op(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity_dist_commutator_op(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity_dist_op(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity_op(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_service_status_to_is_active() TO authenticated;
GRANT EXECUTE ON FUNCTION public.time_dist(time without time zone, time without time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ts_dist(timestamp without time zone, timestamp without time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tstz_dist(timestamp with time zone, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_business_rating() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_countries_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_customer_subscriptions_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_last_active_on_deactivate() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_promo_campaign_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_allowance_event_tenant() TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_fee_basis() TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_promo_campaign_status_transition() TO authenticated;
GRANT EXECUTE ON FUNCTION public.word_similarity(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.word_similarity_commutator_op(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.word_similarity_dist_commutator_op(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.word_similarity_dist_op(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.word_similarity_op(text, text) TO authenticated;

-- Grants to service_role (270 routines)
GRANT EXECUTE ON FUNCTION public.calculate_volume_discount(p_business_id uuid, p_product_id uuid, p_quantity integer, p_unit_price integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cash_dist(money, money) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_business_role(p_user_id uuid, p_business_id uuid, p_required_roles business_role[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_conversation_limit(p_business_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_launch_delivery(p_subscriber_id uuid, p_campaign_version text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_launch_delivery(p_subscriber_id uuid, p_claim_token uuid, p_status text, p_message_id text, p_error text) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_launch_confirmation(p_token uuid, p_admin_id uuid, p_campaign_version text) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_launch_confirmation(p_token uuid, p_admin_id uuid, p_campaign_version text, p_retry_only boolean, p_send_limit integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.date_dist(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.enforce_attempt_status_transitions() TO service_role;
GRANT EXECUTE ON FUNCTION public.enforce_disposition_transitions() TO service_role;
GRANT EXECUTE ON FUNCTION public.enforce_spend_period_provenance_immutability() TO service_role;
GRANT EXECUTE ON FUNCTION public.enforce_wamid_immutability() TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_subscription_cancellation(p_subscription_id uuid, p_provider_event_id text, p_reason text) TO service_role;
GRANT EXECUTE ON FUNCTION public.float4_dist(real, real) TO service_role;
GRANT EXECUTE ON FUNCTION public.float8_dist(double precision, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bit_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bit_consistent(internal, bit, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bit_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bit_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bit_same(gbtreekey_var, gbtreekey_var, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bit_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bool_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bool_consistent(internal, boolean, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bool_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bool_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bool_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bool_same(gbtreekey2, gbtreekey2, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bool_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bpchar_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bpchar_consistent(internal, character, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_consistent(internal, bytea, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_same(gbtreekey_var, gbtreekey_var, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_bytea_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_cash_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_cash_consistent(internal, money, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_cash_distance(internal, money, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_cash_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_cash_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_cash_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_cash_same(gbtreekey16, gbtreekey16, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_cash_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_date_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_date_consistent(internal, date, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_date_distance(internal, date, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_date_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_date_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_date_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_date_same(gbtreekey8, gbtreekey8, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_date_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_decompress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_enum_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_enum_consistent(internal, anyenum, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_enum_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_enum_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_enum_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_enum_same(gbtreekey8, gbtreekey8, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_enum_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float4_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float4_consistent(internal, real, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float4_distance(internal, real, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float4_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float4_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float4_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float4_same(gbtreekey8, gbtreekey8, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float4_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float8_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float8_consistent(internal, double precision, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float8_distance(internal, double precision, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float8_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float8_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float8_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float8_same(gbtreekey16, gbtreekey16, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_float8_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_inet_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_inet_consistent(internal, inet, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_inet_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_inet_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_inet_same(gbtreekey16, gbtreekey16, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_inet_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int2_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int2_consistent(internal, smallint, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int2_distance(internal, smallint, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int2_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int2_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int2_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int2_same(gbtreekey4, gbtreekey4, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int2_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int4_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int4_consistent(internal, integer, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int4_distance(internal, integer, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int4_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int4_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int4_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int4_same(gbtreekey8, gbtreekey8, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int4_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int8_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int8_consistent(internal, bigint, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int8_distance(internal, bigint, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int8_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int8_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int8_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int8_same(gbtreekey16, gbtreekey16, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_int8_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_intv_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_intv_consistent(internal, interval, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_intv_decompress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_intv_distance(internal, interval, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_intv_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_intv_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_intv_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_intv_same(gbtreekey32, gbtreekey32, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_intv_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_same(gbtreekey16, gbtreekey16, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad8_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad_consistent(internal, macaddr, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad_same(gbtreekey16, gbtreekey16, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_macad_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_consistent(internal, numeric, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_same(gbtreekey_var, gbtreekey_var, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_numeric_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_oid_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_oid_consistent(internal, oid, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_oid_distance(internal, oid, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_oid_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_oid_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_oid_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_oid_same(gbtreekey8, gbtreekey8, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_oid_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_text_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_text_consistent(internal, text, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_text_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_text_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_text_same(gbtreekey_var, gbtreekey_var, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_text_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_time_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_time_consistent(internal, time without time zone, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_time_distance(internal, time without time zone, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_time_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_time_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_time_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_time_same(gbtreekey16, gbtreekey16, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_time_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_timetz_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_ts_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_ts_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_ts_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_ts_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_ts_same(gbtreekey16, gbtreekey16, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_ts_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_tstz_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_consistent(internal, uuid, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_same(gbtreekey32, gbtreekey32, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_uuid_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_var_decompress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbt_var_fetch(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbtreekey16_in(cstring) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbtreekey16_out(gbtreekey16) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbtreekey2_in(cstring) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbtreekey2_out(gbtreekey2) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbtreekey32_in(cstring) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbtreekey32_out(gbtreekey32) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbtreekey4_in(cstring) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbtreekey4_out(gbtreekey4) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbtreekey8_in(cstring) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbtreekey8_out(gbtreekey8) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbtreekey_var_in(cstring) TO service_role;
GRANT EXECUTE ON FUNCTION public.gbtreekey_var_out(gbtreekey_var) TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_event_slug() TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_invoice_reference() TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_order_reference() TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_reference_code() TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_reservation_reference() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_effective_config(p_at timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gin_extract_value_trgm(text, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gtrgm_compress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gtrgm_consistent(internal, text, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gtrgm_decompress(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gtrgm_distance(internal, text, smallint, oid, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gtrgm_in(cstring) TO service_role;
GRANT EXECUTE ON FUNCTION public.gtrgm_options(internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gtrgm_out(gtrgm) TO service_role;
GRANT EXECUTE ON FUNCTION public.gtrgm_penalty(internal, internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gtrgm_picksplit(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gtrgm_same(gtrgm, gtrgm, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.gtrgm_union(internal, internal) TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_commercial_settings() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_config_version_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_country_activation() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_country_deletion() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_fee_policy_immutability() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_messaging_suspended() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_paystack_plan_code_authority() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_prize_instructions_integrity() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_provider_ref_authority() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_sending_requires_valid_reservation() TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_site_pages_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.int2_dist(smallint, smallint) TO service_role;
GRANT EXECUTE ON FUNCTION public.int4_dist(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.int8_dist(bigint, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.interval_dist(interval, interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.next_queue_number(biz_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.normalize_promo_keyword() TO service_role;
GRANT EXECUTE ON FUNCTION public.oid_dist(oid, oid) TO service_role;
GRANT EXECUTE ON FUNCTION public.prevent_allowance_event_mutation() TO service_role;
GRANT EXECUTE ON FUNCTION public.prevent_config_version_mutation() TO service_role;
GRANT EXECUTE ON FUNCTION public.prevent_cost_event_mutation() TO service_role;
GRANT EXECUTE ON FUNCTION public.prevent_reconciliation_log_mutation() TO service_role;
GRANT EXECUTE ON FUNCTION public.prevent_snapshot_version_downgrade() TO service_role;
GRANT EXECUTE ON FUNCTION public.prevent_suspension_audit_mutation() TO service_role;
GRANT EXECUTE ON FUNCTION public.prevent_tier_tampering() TO service_role;
GRANT EXECUTE ON FUNCTION public.protect_profiles_role() TO service_role;
GRANT EXECUTE ON FUNCTION public.protect_profiles_role_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.set_limit(real) TO service_role;
GRANT EXECUTE ON FUNCTION public.show_limit() TO service_role;
GRANT EXECUTE ON FUNCTION public.show_trgm(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.similarity(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.similarity_dist(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.similarity_op(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity_commutator_op(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity_dist_commutator_op(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity_dist_op(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.strict_word_similarity_op(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_service_status_to_is_active() TO service_role;
GRANT EXECUTE ON FUNCTION public.time_dist(time without time zone, time without time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.ts_dist(timestamp without time zone, timestamp without time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.tstz_dist(timestamp with time zone, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_business_rating() TO service_role;
GRANT EXECUTE ON FUNCTION public.update_countries_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.update_customer_subscriptions_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.update_last_active_on_deactivate() TO service_role;
GRANT EXECUTE ON FUNCTION public.update_promo_campaign_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_allowance_event_tenant() TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_fee_basis() TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_promo_campaign_status_transition() TO service_role;
GRANT EXECUTE ON FUNCTION public.word_similarity(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.word_similarity_commutator_op(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.word_similarity_dist_commutator_op(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.word_similarity_dist_op(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.word_similarity_op(text, text) TO service_role;

-- ============================================================
-- POSTCONDITIONS
-- ============================================================

DO $$
DECLARE
  v_svc_tables  integer;
  v_anon_tables integer;
  v_auth_tables integer;
  v_dacl_count  integer;
  v_bpc_count   integer;
  v_ps_anon     integer;
  v_biz_anon    integer;
  v_wa_anon     integer;
BEGIN
  -- service_role granted on 197 tables
  SELECT count(DISTINCT table_name) INTO v_svc_tables
    FROM information_schema.role_table_grants
   WHERE grantee = 'service_role' AND table_schema = 'public';
  IF v_svc_tables <> 197 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role tables expected 197, got %', v_svc_tables;
  END IF;

  -- anon granted on 167 tables
  SELECT count(DISTINCT table_name) INTO v_anon_tables
    FROM information_schema.role_table_grants
   WHERE grantee = 'anon' AND table_schema = 'public';
  IF v_anon_tables <> 167 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon tables expected 167, got %', v_anon_tables;
  END IF;

  -- authenticated granted on 178 tables
  SELECT count(DISTINCT table_name) INTO v_auth_tables
    FROM information_schema.role_table_grants
   WHERE grantee = 'authenticated' AND table_schema = 'public';
  IF v_auth_tables <> 178 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated tables expected 178, got %', v_auth_tables;
  END IF;

  -- default ACLs should be 6
  SELECT count(*) INTO v_dacl_count
    FROM pg_default_acl da
    JOIN pg_namespace n ON n.oid = da.defaclnamespace
   WHERE n.nspname = 'public';
  IF v_dacl_count <> 6 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: default ACLs expected 6, got %', v_dacl_count;
  END IF;

  -- business_payment_credentials must have NO grants
  SELECT count(*) INTO v_bpc_count
    FROM information_schema.role_table_grants
   WHERE table_name = 'business_payment_credentials'
     AND table_schema = 'public'
     AND grantee IN ('anon','authenticated','service_role');
  IF v_bpc_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: business_payment_credentials must have no role grants, got %', v_bpc_count;
  END IF;

  -- Critical table: platform_settings must have anon access
  SELECT count(*) INTO v_ps_anon
    FROM information_schema.role_table_grants
   WHERE table_name = 'platform_settings'
     AND table_schema = 'public'
     AND grantee = 'anon'
     AND privilege_type = 'SELECT';
  IF v_ps_anon = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: platform_settings must have anon SELECT';
  END IF;

  -- Critical table: businesses must have no anon grants
  SELECT count(*) INTO v_biz_anon
    FROM information_schema.role_table_grants
   WHERE table_name = 'businesses'
     AND table_schema = 'public'
     AND grantee = 'anon';
  IF v_biz_anon <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: businesses must have no anon grants, got %', v_biz_anon;
  END IF;

  -- Critical table: whatsapp_channels must have no anon grants
  SELECT count(*) INTO v_wa_anon
    FROM information_schema.role_table_grants
   WHERE table_name = 'whatsapp_channels'
     AND table_schema = 'public'
     AND grantee = 'anon';
  IF v_wa_anon <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: whatsapp_channels must have no anon grants, got %', v_wa_anon;
  END IF;

  RAISE NOTICE 'POSTCONDITIONS PASSED: svc_tables=%, anon_tables=%, auth_tables=%, default_acls=%',
    v_svc_tables, v_anon_tables, v_auth_tables, v_dacl_count;
END $$;

COMMIT;