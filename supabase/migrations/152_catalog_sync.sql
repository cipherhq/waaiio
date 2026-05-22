-- ══ WhatsApp Catalog Sync ══

-- 1. Track product → WhatsApp product ID mappings
ALTER TABLE products ADD COLUMN IF NOT EXISTS whatsapp_product_id TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS catalog_synced_at TIMESTAMPTZ;

-- 2. Store catalog ID on business (dedicated column)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS whatsapp_catalog_id TEXT;

-- 3. Catalog sync history
CREATE TABLE IF NOT EXISTS catalog_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  catalog_id TEXT NOT NULL,
  synced_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  error_message TEXT,
  status TEXT CHECK (status IN ('pending', 'success', 'partial', 'failed')) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_catalog_sync_logs_business ON catalog_sync_logs(business_id);

-- RLS
ALTER TABLE catalog_sync_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_manage_catalog_logs" ON catalog_sync_logs
  FOR ALL USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

CREATE POLICY "service_role_all_catalog_logs" ON catalog_sync_logs
  FOR ALL TO service_role USING (true);
