-- Migration 332: Add promo_verification to capability_type enum
--
-- The promo_verification capability was defined in shared/capabilities.ts
-- and registered in REQUIRED_TEMPLATES, CAPABILITY_GROUPS, and onboarding
-- StepFeatures, but was never added to the PostgreSQL capability_type enum.
--
-- This blocks INSERT INTO business_capabilities with capability='promo_verification'
-- because the column is typed as capability_type (a PostgreSQL enum).
--
-- This migration adds the missing enum value so Promotions can be enabled.

ALTER TYPE capability_type ADD VALUE IF NOT EXISTS 'promo_verification';
