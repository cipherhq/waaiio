-- Add file_size tracking to customer_reports for storage quota enforcement
ALTER TABLE customer_reports ADD COLUMN IF NOT EXISTS file_size integer NOT NULL DEFAULT 0;

-- Secure document access: token for verification link, access count for tracking
ALTER TABLE customer_reports ADD COLUMN IF NOT EXISTS access_token varchar(20);
ALTER TABLE customer_reports ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_customer_reports_biz_size ON customer_reports(business_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_reports_access_token ON customer_reports(access_token) WHERE access_token IS NOT NULL;
