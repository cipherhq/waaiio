-- Add 'dashboard' to booking_channel enum for manual bookings created from dashboard
ALTER TYPE booking_channel ADD VALUE IF NOT EXISTS 'dashboard';
