/**
 * Bootstrap fixtures for M496 channel-number-continuity PG tests.
 *
 * Provides base schema (auth, roles, core tables), M439 section 1 extract
 * (admin_step_up_authorizations table), and deterministic seed data.
 * Actual migrations (M391, M430, M494, M496) are loaded via readFileSync
 * in the test file for faithful reproduction.
 *
 * Source of M439 extract: supabase/migrations/439_admin_mfa_enforcement.sql
 */

// ── Deterministic test UUIDs (all valid UUID v4) ─────────────────
export const OWNER  = '11111111-1111-4111-a111-111111111111';
export const ADMIN1 = '22222222-2222-4222-a222-222222222222'; // requester
export const ADMIN2 = '33333333-3333-4333-a333-333333333333'; // approver
export const ADMIN3 = '44444444-4444-4444-a444-444444444444'; // executor
export const BIZ    = '55555555-5555-4555-a555-555555555555';
export const SH_NG  = '66666666-6666-4666-a666-666666666666'; // shared channel NG
export const SH_GB  = '77777777-7777-4777-a777-777777777777'; // shared channel GB
export const DEDIC  = '88888888-8888-4888-a888-888888888888'; // dedicated channel
export const CAND   = '99999999-9999-4999-a999-999999999999'; // candidate
export const M_SU   = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'; // merchant step-up
export const A_SU   = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'; // admin step-up (executor)
export const APPR   = 'cccccccc-cccc-4ccc-accc-cccccccccccc'; // approval
export const REQ_SU = 'dddddddd-dddd-4ddd-addd-dddddddddddd'; // requester admin step-up
export const APP_SU = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee'; // approver admin step-up
export const BZDOC      = 'ffffffff-ffff-4fff-afff-ffffffffffff'; // business document (approved)
export const REJ_DOC    = '00000001-0001-4001-a001-000000000001'; // rejected document (same biz)
export const FOREIGN_BIZ = '00000002-0002-4002-a002-000000000002'; // unrelated business
export const FOREIGN_DOC = '00000003-0003-4003-a003-000000000003'; // approved doc for FOREIGN_BIZ
export const VREC       = '00000004-0004-4004-a004-000000000004'; // verification_request (completed)

/** Base schema: PG roles, auth schema, core tables. */
export const BOOTSTRAP_SQL = `
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_app_meta_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT ALL ON auth.users TO service_role;
-- Relevant production columns and FK from M001/M010; audit failures must be real.
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES public.profiles(id),
  action VARCHAR(50) NOT NULL, entity_type VARCHAR(50), entity_id UUID,
  details JSONB DEFAULT '{}', ip_address VARCHAR(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
GRANT SELECT, INSERT ON public.admin_audit_logs TO service_role;

CREATE TABLE IF NOT EXISTS public.businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT DEFAULT 'Test', owner_id UUID REFERENCES auth.users(id),
  assigned_channel_id UUID, whatsapp_channel_id UUID,
  wa_method TEXT DEFAULT 'shared', country_code TEXT DEFAULT 'NG',
  status TEXT DEFAULT 'active', slug TEXT, subscription_tier TEXT DEFAULT 'free',
  metadata JSONB DEFAULT '{}'::jsonb, payment_gateway TEXT,
  stripe_customer_id TEXT, stripe_subscription_id TEXT,
  verification_level TEXT, messaging_suspended BOOLEAN DEFAULT false,
  category TEXT, flow_type TEXT, trial_ends_at TIMESTAMPTZ,
  operating_hours JSONB, is_whitelabel BOOLEAN DEFAULT false, bot_code TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.whatsapp_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES public.businesses(id),
  provider TEXT DEFAULT 'meta_cloud', channel_type TEXT DEFAULT 'shared',
  phone_number TEXT, phone_number_id TEXT, waba_id TEXT,
  meta_access_token TEXT, meta_token_expires_at TIMESTAMPTZ,
  display_name TEXT, country_code TEXT DEFAULT 'NG',
  connection_method TEXT DEFAULT 'shared', connection_status TEXT DEFAULT 'active',
  is_active BOOLEAN DEFAULT true, metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key TEXT PRIMARY KEY, value JSONB, description TEXT DEFAULT '',
  updated_by UUID, updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.business_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  file_url TEXT NOT NULL,
  file_name VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
GRANT ALL ON public.businesses TO service_role;
GRANT ALL ON public.whatsapp_channels TO service_role;
GRANT ALL ON public.platform_settings TO service_role;
GRANT ALL ON public.business_documents TO service_role;
CREATE TABLE IF NOT EXISTS public.verification_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  requested_level TEXT NOT NULL DEFAULT 'basic',
  requested_by UUID NOT NULL DEFAULT '33333333-3333-4333-a333-333333333333',
  documents_required TEXT[] NOT NULL DEFAULT '{}',
  message TEXT
);
GRANT ALL ON public.verification_requests TO service_role;
`;

/**
 * M439 section 1 extract: admin_step_up_authorizations table + RLS + grants.
 * Exact structure from supabase/migrations/439_admin_mfa_enforcement.sql lines 28-74.
 */
export const M439_S1_SQL = `
CREATE TABLE IF NOT EXISTS public.admin_step_up_authorizations (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id     text        NOT NULL,
  action_type    text        NOT NULL CHECK (action_type IN (
    'payout_approve','payout_reject','payout_generate',
    'provider_config','team_grant','team_revoke','impersonate','refund',
    'reseller_payout_approve','reseller_payout_reject',
    'reseller_payout_mark_paid','reseller_payout_generate',
    'commercial_config','messaging_config','messaging_suspension'
  )),
  target_id      text, params_hash text NOT NULL,
  challenge_id   uuid, factor_id uuid,
  verified_at    timestamptz, consumed_at timestamptz,
  expires_at     timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_step_up_authorizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_step_up_deny_all" ON public.admin_step_up_authorizations
  FOR ALL USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE ON TABLE public.admin_step_up_authorizations TO service_role;
REVOKE ALL ON TABLE public.admin_step_up_authorizations FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_admin_step_up_lookup
  ON public.admin_step_up_authorizations (admin_user_id, consumed_at, expires_at);
`;

/** Truncate all seeded tables. Platform_settings preserved (M430 seeds capacity). */
export const TRUNCATE_SQL = `
TRUNCATE
  public.admin_audit_logs,
  public.profiles,
  public.channel_transition_audit,
  public.channel_change_approvals,
  public.merchant_step_up_authorizations,
  public.admin_step_up_authorizations,
  public.whatsapp_channel_secrets,
  public.whatsapp_channel_candidates,
  public.whatsapp_channels,
  public.verification_requests,
  public.business_documents,
  public.businesses,
  auth.users
CASCADE;
`;

/** Common seed: owner, 3 admins, business in NG, two shared channels. */
export const SEED_SQL = `
INSERT INTO auth.users (id, raw_app_meta_data) VALUES
  ('${OWNER}', '{"role":"merchant"}'::jsonb),
  ('${ADMIN1}', '{"role":"admin"}'::jsonb),
  ('${ADMIN2}', '{"role":"admin"}'::jsonb),
  ('${ADMIN3}', '{"role":"admin"}'::jsonb);
INSERT INTO public.profiles(id) SELECT id FROM auth.users;
INSERT INTO public.businesses (
  id, name, owner_id, wa_method, assigned_channel_id, whatsapp_channel_id,
  country_code, status, slug, subscription_tier, metadata,
  payment_gateway, verification_level, messaging_suspended
) VALUES (
  '${BIZ}', 'Test Biz', '${OWNER}', 'transfer', NULL, NULL,
  'NG', 'active', 'test-biz', 'growth', '{"key":"val"}'::jsonb,
  'stripe', 'verified', false
);
INSERT INTO public.whatsapp_channels (id, channel_type, country_code, phone_number, is_active, connection_status, business_id)
VALUES
  ('${SH_NG}', 'shared', 'NG', '+2349000000001', true, 'active', NULL),
  ('${SH_GB}', 'shared', 'GB', '+447000000001', true, 'active', NULL);
INSERT INTO public.businesses (id, name, owner_id, wa_method, country_code, status, slug, subscription_tier)
VALUES ('${FOREIGN_BIZ}', 'Foreign Biz', '${ADMIN1}', 'transfer', 'NG', 'active', 'foreign-biz', 'free');
INSERT INTO public.business_documents (id, business_id, type, file_url, file_name, status, reviewed_by, reviewed_at)
VALUES
  ('${BZDOC}',       '${BIZ}',         'government_id', '/documents/${BIZ}/id.pdf',        'id.pdf',  'approved', '${ADMIN2}', NOW()),
  ('${REJ_DOC}',     '${BIZ}',         'government_id', '/documents/${BIZ}/rej.pdf',        'rej.pdf', 'rejected', NULL,        NULL),
  ('${FOREIGN_DOC}', '${FOREIGN_BIZ}', 'government_id', '/documents/${FOREIGN_BIZ}/id.pdf', 'id.pdf',  'approved', '${ADMIN2}', NOW());
INSERT INTO public.verification_requests (
  id, business_id, status, completed_at,
  requested_level, requested_by, documents_required, message
) VALUES (
  '${VREC}', '${BIZ}', 'completed', NOW(),
  'enhanced', '${ADMIN2}', ARRAY['government_id'], 'Identity verification for channel recovery'
);
`;
