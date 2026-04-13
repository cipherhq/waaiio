-- Add document_content column to contracts table
-- Stores the full document body text that signers review before signing
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS document_content text;
