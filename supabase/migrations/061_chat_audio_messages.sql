-- Add media support columns to chat_messages for audio (and future image/document) attachments
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_url text;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_type varchar(20);
-- media_type values: 'audio', 'image', 'document' (future-proof)
