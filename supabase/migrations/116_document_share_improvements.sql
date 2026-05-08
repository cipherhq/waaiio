-- Add file_size tracking to customer_reports for storage quota enforcement
ALTER TABLE customer_reports ADD COLUMN IF NOT EXISTS file_size integer NOT NULL DEFAULT 0;

-- Index for efficient per-business storage usage calculation
CREATE INDEX IF NOT EXISTS idx_customer_reports_biz_size ON customer_reports(business_id);
