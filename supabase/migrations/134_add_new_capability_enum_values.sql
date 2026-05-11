-- Add new capability enum values (broadcast, recurring, auto_reply, membership)
-- These were added to the TypeScript types but NOT to the DB enum
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'broadcast';
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'recurring';
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'auto_reply';
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'membership';
