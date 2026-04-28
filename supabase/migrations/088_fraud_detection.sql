-- Fraud detection: track payment metadata for traceback
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS payer_ip TEXT,
  ADD COLUMN IF NOT EXISTS payer_country TEXT,
  ADD COLUMN IF NOT EXISTS payer_device_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS fraud_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fraud_flags JSONB DEFAULT '[]';

-- Fraud events log
CREATE TABLE IF NOT EXISTS fraud_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID REFERENCES public.payments(id),
  business_id UUID REFERENCES public.businesses(id),
  event_type VARCHAR(50) NOT NULL,
  severity VARCHAR(10) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  description TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  resolved BOOLEAN DEFAULT false,
  resolved_by UUID REFERENCES auth.users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fraud_events_business ON fraud_events(business_id);
CREATE INDEX idx_fraud_events_unresolved ON fraud_events(resolved) WHERE resolved = false;
CREATE INDEX idx_payments_fraud ON public.payments(fraud_score) WHERE fraud_score > 0;
