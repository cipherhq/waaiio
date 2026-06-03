-- API keys for external integrations
CREATE TABLE public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_hash ON public.api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_api_keys_business ON public.api_keys(business_id);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_manage_api_keys" ON public.api_keys
  FOR ALL USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- Add 'api' to booking_channel enum
ALTER TYPE booking_channel ADD VALUE IF NOT EXISTS 'api';
