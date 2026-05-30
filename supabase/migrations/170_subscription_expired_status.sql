-- Add 'expired' to subscription_status enum for subscription expiry enforcement
ALTER TYPE subscription_status ADD VALUE IF NOT EXISTS 'expired';
