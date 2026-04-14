-- Expand contract status to include 'declined'
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_status_check;
ALTER TABLE contracts ADD CONSTRAINT contracts_status_check
  CHECK (status IN ('pending', 'signed', 'expired', 'revoked', 'declined'));

-- Decline tracking
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS declined_at timestamptz;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS decline_reason text;

-- OTP verification
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS otp_code varchar(6);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS otp_expires_at timestamptz;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS otp_verified boolean DEFAULT false;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS otp_attempts integer DEFAULT 0;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS require_otp boolean DEFAULT false;
