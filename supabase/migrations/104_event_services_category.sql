-- Add event_services category for businesses that provide event services (photo booths, DJs, decor, etc.)
-- Distinct from 'events' which is for ticket-selling businesses (concerts, cinemas)
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'event_services';
