-- Add reference codes to contracts and contract_signers
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS reference_code VARCHAR(20);
ALTER TABLE contract_signers ADD COLUMN IF NOT EXISTS signature_reference VARCHAR(20);
