-- Fix: add SET search_path to all SECURITY DEFINER functions
-- This prevents search_path injection attacks (CWE-20)
-- See: https://supabase.com/docs/guides/database/hardening#set-search_path

-- handle_new_user() — from 001_initial_schema.sql
ALTER FUNCTION public.handle_new_user() SET search_path = public;

-- is_admin() — from 012_admin_expansion.sql
ALTER FUNCTION public.is_admin() SET search_path = public;

-- is_support() — from 069_security_and_impersonation.sql
ALTER FUNCTION public.is_support() SET search_path = public;

-- is_admin_or_support() — from 161_admin_roles_finance_operations.sql
ALTER FUNCTION public.is_admin_or_support() SET search_path = public;

-- check_business_role(uuid, uuid, business_role[]) — from 099_business_members.sql
ALTER FUNCTION public.check_business_role(uuid, uuid, business_role[]) SET search_path = public;

-- decrement_stock(uuid, integer) — from 020_new_capabilities.sql
ALTER FUNCTION public.decrement_stock(uuid, integer) SET search_path = public;

-- decrement_variant_stock(uuid, integer) — from 030_product_variants_shipping.sql
ALTER FUNCTION public.decrement_variant_stock(uuid, integer) SET search_path = public;

-- reserve_booking_slot — from 021_product_enhancements.sql
-- Signature: (uuid, date, time, time, uuid, uuid, integer)
ALTER FUNCTION public.reserve_booking_slot(uuid, date, time, time, uuid, uuid, integer) SET search_path = public;

-- release_booking_slot — from 021_product_enhancements.sql
-- Signature: (uuid, date, time, uuid, uuid)
ALTER FUNCTION public.release_booking_slot(uuid, date, time, uuid, uuid) SET search_path = public;

-- increment_promo_usage(uuid) — from 021_product_enhancements.sql
ALTER FUNCTION public.increment_promo_usage(uuid) SET search_path = public;

-- upsert_customer_profile(uuid, text, text, numeric, boolean, boolean) — from 021_product_enhancements.sql
ALTER FUNCTION public.upsert_customer_profile(uuid, text, text, numeric, boolean, boolean) SET search_path = public;

-- increment_chat_forwards(uuid) — from 026_chat_forwarding.sql
ALTER FUNCTION public.increment_chat_forwards(uuid) SET search_path = public;

-- reset_low_stock_alerts() — from 031_automation_enhancements.sql
ALTER FUNCTION public.reset_low_stock_alerts() SET search_path = public;

-- increment_broadcast_usage(uuid, integer) — from 035_broadcast_usage.sql
ALTER FUNCTION public.increment_broadcast_usage(uuid, integer) SET search_path = public;

-- increment_message_usage(uuid, text, boolean) — from 081_conversation_usage.sql
ALTER FUNCTION public.increment_message_usage(uuid, text, boolean) SET search_path = public;

-- check_conversation_limit(uuid) — from 095_update_conversation_limits.sql
ALTER FUNCTION public.check_conversation_limit(uuid) SET search_path = public;

-- increment_ai_usage(uuid, text, text) — from 091_ai_tier_usage_columns.sql
ALTER FUNCTION public.increment_ai_usage(uuid, text, text) SET search_path = public;

-- increment_form_response_count(uuid) — from 156_atomic_form_response_count.sql
ALTER FUNCTION public.increment_form_response_count(uuid) SET search_path = public;

-- increment_customer_visit(uuid, text, numeric) — from 165_auto_customer_profile.sql
ALTER FUNCTION public.increment_customer_visit(uuid, text, numeric) SET search_path = public;
