-- OCR result storage + admin RLS for bank transfer tables

-- Store OCR extraction results on pending_transfers
ALTER TABLE pending_transfers ADD COLUMN IF NOT EXISTS ocr_result JSONB;

-- Admin read access to business_bank_accounts (was missing)
CREATE POLICY "Admin reads bank accounts" ON business_bank_accounts
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'support', 'finance', 'operations'))
  );

-- Admin write access to pending_transfers (for force-confirm/reject)
CREATE POLICY "Admin manages pending transfers" ON pending_transfers
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'finance'))
  );
