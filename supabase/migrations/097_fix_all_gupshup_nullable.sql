-- Make all Gupshup-specific columns nullable since we use Meta Cloud API directly
ALTER TABLE whatsapp_channels ALTER COLUMN gupshup_api_key DROP NOT NULL;
ALTER TABLE whatsapp_channels ALTER COLUMN gupshup_api_key SET DEFAULT NULL;
ALTER TABLE whatsapp_channels ALTER COLUMN phone_number DROP NOT NULL;
ALTER TABLE whatsapp_channels ALTER COLUMN phone_number SET DEFAULT NULL;
