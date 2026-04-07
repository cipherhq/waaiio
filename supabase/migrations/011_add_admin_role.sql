-- Add 'admin' to user_role enum
-- Must be in its own migration because PostgreSQL cannot use
-- a newly added enum value in the same transaction
DO $$
BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'admin';
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END $$;
