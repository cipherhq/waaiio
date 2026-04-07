-- ═══════════════════════════════════════════════════════
-- 018: Healthcare Features — Reports & Queue System
-- ═══════════════════════════════════════════════════════

-- ── Table: customer_reports ──────────────────────────

CREATE TABLE IF NOT EXISTS customer_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL,
  customer_name TEXT,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_url TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_customer_reports_biz_status ON customer_reports (business_id, status);
CREATE INDEX idx_customer_reports_phone_biz ON customer_reports (customer_phone, business_id);

-- RLS
ALTER TABLE customer_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business owners can manage their reports"
  ON customer_reports FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Service role full access to reports"
  ON customer_reports FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');


-- ── Table: queue_entries ─────────────────────────────

CREATE TABLE IF NOT EXISTS queue_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL,
  customer_name TEXT,
  queue_number INT NOT NULL,
  queue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'serving', 'completed', 'no_show')),
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  called_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  estimated_wait_minutes INT,
  channel VARCHAR(10) NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'web')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_queue_entry UNIQUE (business_id, queue_date, queue_number)
);

-- Indexes
CREATE INDEX idx_queue_entries_biz_date_status ON queue_entries (business_id, queue_date, status);
CREATE INDEX idx_queue_entries_phone_biz ON queue_entries (customer_phone, business_id);

-- RLS
ALTER TABLE queue_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business owners can manage their queue"
  ON queue_entries FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Service role full access to queue"
  ON queue_entries FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');


-- ── Function: next_queue_number ──────────────────────

CREATE OR REPLACE FUNCTION next_queue_number(biz_id UUID)
RETURNS INT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(MAX(queue_number), 0) + 1
  FROM queue_entries
  WHERE business_id = biz_id
    AND queue_date = CURRENT_DATE;
$$;


-- ── Storage bucket for customer reports ──────────────

INSERT INTO storage.buckets (id, name, public)
VALUES ('customer-reports', 'customer-reports', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policy: business owners can upload
CREATE POLICY "Business owners upload reports"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'customer-reports'
    AND auth.role() = 'authenticated'
  );

-- Storage policy: business owners can read their own reports
CREATE POLICY "Business owners read reports"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'customer-reports'
    AND auth.role() = 'authenticated'
  );

-- Storage policy: service role full access
CREATE POLICY "Service role reports access"
  ON storage.objects FOR ALL
  USING (bucket_id = 'customer-reports' AND auth.role() = 'service_role')
  WITH CHECK (bucket_id = 'customer-reports' AND auth.role() = 'service_role');
