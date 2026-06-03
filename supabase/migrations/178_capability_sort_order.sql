-- Add sort_order column to business_capabilities for custom bot menu ordering
ALTER TABLE business_capabilities ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;

-- Index for efficient ordering queries
CREATE INDEX IF NOT EXISTS idx_business_capabilities_sort_order
  ON business_capabilities (business_id, sort_order ASC, capability ASC)
  WHERE is_enabled = true;
