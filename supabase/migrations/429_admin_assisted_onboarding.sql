-- Durable, server-owned state for administrator-assisted customer onboarding.
-- Browser clients receive no table privileges; all access is through authenticated
-- /api/admin/onboarding routes using the service role after app_metadata authorization.

CREATE TABLE public.admin_onboarding_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_admin_id UUID NOT NULL REFERENCES public.profiles(id),
  target_email TEXT NOT NULL,
  target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('draft', 'provisioning', 'invite_pending', 'invite_sent',
      'customer_action_required', 'active', 'failed', 'cancelled')),
  intended_plan public.subscription_tier NOT NULL DEFAULT 'free',
  whatsapp_method TEXT NOT NULL DEFAULT 'shared'
    CHECK (whatsapp_method IN ('shared', 'dedicated', 'coexistence')),
  request_key UUID NOT NULL,
  invite_sent_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (created_by_admin_id, request_key)
);

CREATE INDEX idx_admin_onboarding_status
  ON public.admin_onboarding_invites(status, created_at DESC);
CREATE INDEX idx_admin_onboarding_email
  ON public.admin_onboarding_invites(lower(target_email));
CREATE UNIQUE INDEX idx_admin_onboarding_open_email
  ON public.admin_onboarding_invites(lower(target_email))
  WHERE status NOT IN ('failed', 'cancelled');

CREATE TRIGGER update_admin_onboarding_invites_updated_at
  BEFORE UPDATE ON public.admin_onboarding_invites
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.admin_onboarding_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_onboarding_invites FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_onboarding_invites TO service_role;

COMMENT ON TABLE public.admin_onboarding_invites IS
  'Server-owned state for full-admin assisted customer onboarding; no browser access.';
COMMENT ON COLUMN public.admin_onboarding_invites.intended_plan IS
  'Plan intent only. Paid entitlement remains free until canonical checkout activation.';
