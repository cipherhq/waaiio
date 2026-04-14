-- CC recipients for contracts
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS cc_recipients jsonb DEFAULT '[]'::jsonb;
