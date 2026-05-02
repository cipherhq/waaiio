-- Add 'pending' to order_status enum for orders awaiting payment
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'pending' BEFORE 'confirmed';
