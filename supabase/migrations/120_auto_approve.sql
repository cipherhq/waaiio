-- Auto-approve toggle for appointments and services
-- When true: booking status = 'confirmed' immediately (no manual approval needed)
-- When false: booking status = 'pending' until business approves
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS auto_approve boolean NOT NULL DEFAULT true;
ALTER TABLE services ADD COLUMN IF NOT EXISTS auto_approve boolean NOT NULL DEFAULT true;
