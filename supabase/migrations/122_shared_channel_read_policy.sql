-- Allow any authenticated user to read active shared WhatsApp channels
-- Shared channels are platform numbers (not sensitive) — businesses need
-- to see them during onboarding and for ReturnToWhatsApp links
CREATE POLICY shared_channels_public_read ON whatsapp_channels
  FOR SELECT USING (channel_type = 'shared' AND is_active = true);
