-- ═══════════════════════════════════════════════════════
-- 090: RLS Security Hardening
-- Fix 3 tables missing RLS + 4 overly permissive policies
-- ═══════════════════════════════════════════════════════

-- ══════════════════════════════════════
-- 1. CRITICAL: Tables missing RLS entirely
-- ══════════════════════════════════════

-- fraud_events — admin + service only
ALTER TABLE fraud_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fraud_events_admin_read" ON fraud_events
  FOR SELECT USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "fraud_events_service" ON fraud_events
  FOR ALL USING (auth.role() = 'service_role');

-- ai_usage — business owner reads own, admin reads all, service full access
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_usage_owner" ON ai_usage
  FOR SELECT USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

CREATE POLICY "ai_usage_admin" ON ai_usage
  FOR SELECT USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "ai_usage_service" ON ai_usage
  FOR ALL USING (auth.role() = 'service_role');

-- conversation_usage — business owner reads own, service full access
ALTER TABLE conversation_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversation_usage_owner" ON conversation_usage
  FOR SELECT USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

CREATE POLICY "conversation_usage_admin" ON conversation_usage
  FOR SELECT USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "conversation_usage_service" ON conversation_usage
  FOR ALL USING (auth.role() = 'service_role');

-- ══════════════════════════════════════
-- 2. HIGH: Fix overly permissive USING(true) policies
-- ══════════════════════════════════════

-- promo_codes: SELECT was open to everyone
DROP POLICY IF EXISTS "promo_codes_service_select" ON promo_codes;
CREATE POLICY "promo_codes_service_select" ON promo_codes
  FOR SELECT USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
    OR auth.role() = 'service_role'
  );

-- audit_log: INSERT was open to everyone
DROP POLICY IF EXISTS "audit_log_service_insert" ON audit_log;
CREATE POLICY "audit_log_service_insert" ON audit_log
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- business_faq: SELECT was open to everyone
DROP POLICY IF EXISTS "business_faq_service_select" ON business_faq;
CREATE POLICY "business_faq_service_select" ON business_faq
  FOR SELECT USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
    OR auth.role() = 'service_role'
  );

-- daily_summary_log: INSERT was open to everyone
DROP POLICY IF EXISTS "daily_summary_log_service_insert" ON daily_summary_log;
CREATE POLICY "daily_summary_log_service_insert" ON daily_summary_log
  FOR INSERT WITH CHECK (auth.role() = 'service_role');
