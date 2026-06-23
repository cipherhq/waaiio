-- Receipt OCR auto-verification support
-- Adds verified_by_ocr flag to pending_transfers for tracking auto-confirmed transfers

ALTER TABLE pending_transfers ADD COLUMN IF NOT EXISTS verified_by_ocr BOOLEAN DEFAULT FALSE;

-- Index for analytics: how many transfers were auto-verified
CREATE INDEX IF NOT EXISTS idx_pending_transfers_ocr
  ON pending_transfers (verified_by_ocr) WHERE verified_by_ocr = TRUE;
