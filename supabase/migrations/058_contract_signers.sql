-- Multiple signers support
CREATE TABLE IF NOT EXISTS contract_signers (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  signer_name varchar(200),
  signer_phone varchar(30) NOT NULL,
  signer_email varchar(200),
  signing_order integer DEFAULT 1,
  token varchar(64) UNIQUE NOT NULL,
  token_expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
  status varchar(20) DEFAULT 'pending'
    CHECK (status IN ('pending', 'signed', 'expired', 'revoked', 'declined', 'waiting')),
  signature_data text,
  signed_at timestamptz,
  audit_trail jsonb DEFAULT '{}'::jsonb,
  otp_code varchar(6),
  otp_expires_at timestamptz,
  otp_verified boolean DEFAULT false,
  otp_attempts integer DEFAULT 0,
  decline_reason text,
  declined_at timestamptz,
  reminder_24h_sent boolean DEFAULT false,
  reminder_48h_sent boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_contract_signers_contract ON contract_signers(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_signers_token ON contract_signers(token);
CREATE INDEX IF NOT EXISTS idx_contract_signers_status ON contract_signers(contract_id, status);

-- Signing mode on parent contract
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS signing_mode varchar(20) DEFAULT 'single'
  CHECK (signing_mode IN ('single', 'parallel', 'sequential'));

-- RLS policies for contract_signers
ALTER TABLE contract_signers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business owners can manage their signers"
  ON contract_signers FOR ALL
  USING (
    contract_id IN (
      SELECT c.id FROM contracts c
      JOIN businesses b ON b.id = c.business_id
      WHERE b.owner_id = auth.uid()
    )
  );

CREATE POLICY "Service role full access on contract_signers"
  ON contract_signers FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
