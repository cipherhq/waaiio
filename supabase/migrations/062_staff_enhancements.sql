-- Staff enhancements: free-text roles, photo, commission, notes, start date, color tag

-- Drop CHECK constraint on role to allow free-text (currently: 'staff', 'manager' only)
ALTER TABLE business_staff DROP CONSTRAINT IF EXISTS business_staff_role_check;

-- Add new columns (all nullable, no breaking changes)
ALTER TABLE business_staff ADD COLUMN IF NOT EXISTS photo_url text;
ALTER TABLE business_staff ADD COLUMN IF NOT EXISTS commission_rate numeric(5,2);
ALTER TABLE business_staff ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE business_staff ADD COLUMN IF NOT EXISTS start_date date;
ALTER TABLE business_staff ADD COLUMN IF NOT EXISTS color varchar(20);
