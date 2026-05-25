-- Pre-booking questions: answers stored in bookings.metadata
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Custom follow-up message and delay
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS followup_message TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS followup_delay_hours INTEGER DEFAULT 24;
