-- Allow gupshup_app_name to be nullable for Meta Cloud channels
ALTER TABLE whatsapp_channels ALTER COLUMN gupshup_app_name DROP NOT NULL;
ALTER TABLE whatsapp_channels ALTER COLUMN gupshup_app_name SET DEFAULT NULL;
