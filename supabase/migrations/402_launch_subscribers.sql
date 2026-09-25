-- #395: Launch subscriber tracking for WhatsApp-first launch opt-in.
-- Isolated from commerce, payment, and bot conversation state — purely launch marketing.

CREATE TABLE IF NOT EXISTS public.launch_subscribers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_number       TEXT NOT NULL,
  market          VARCHAR(4) NOT NULL,            -- country code (NG, US, GH, etc.)
  receiving_number TEXT NOT NULL,                  -- Waaiio WhatsApp number that received the opt-in
  signup_source   TEXT NOT NULL DEFAULT 'button',  -- 'qr' | 'button' | 'direct'
  opt_in_status   TEXT NOT NULL DEFAULT 'active' CHECK (opt_in_status IN ('active', 'opted_out')),
  notification_status TEXT NOT NULL DEFAULT 'pending' CHECK (notification_status IN ('pending', 'sent', 'failed', 'skipped')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotent: one subscription per WhatsApp number
  CONSTRAINT launch_subscribers_wa_number_unique UNIQUE (wa_number)
);

-- Indexes for admin reporting
CREATE INDEX IF NOT EXISTS idx_launch_subscribers_market ON launch_subscribers(market);
CREATE INDEX IF NOT EXISTS idx_launch_subscribers_status ON launch_subscribers(opt_in_status);
CREATE INDEX IF NOT EXISTS idx_launch_subscribers_created ON launch_subscribers(created_at);

-- RLS: admin-only access (no public read/write via client)
ALTER TABLE launch_subscribers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_all_launch_subscribers" ON launch_subscribers
  FOR ALL USING (public.is_admin());

COMMENT ON TABLE launch_subscribers IS 'Launch notification subscribers — WhatsApp-first opt-in. Isolated from commerce/payment flows.';
