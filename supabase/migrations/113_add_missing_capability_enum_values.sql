-- Add missing capability_type enum values (survey, reports, queue)
-- These were added to TypeScript types but not to the DB enum
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'survey';
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'reports';
ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'queue';
