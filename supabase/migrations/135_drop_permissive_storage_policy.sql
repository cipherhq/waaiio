-- Drop the overly permissive upload policy from migration 033
-- that allows ANY authenticated user to upload to business-documents bucket.
-- Migration 133 already added owner-scoped policies, but forgot to drop this one.
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
