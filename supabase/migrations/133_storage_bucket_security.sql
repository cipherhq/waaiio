-- Fix contracts bucket — any authenticated user can read/write all contracts
-- Restrict to business owners only based on folder structure (first folder = business_id)
DROP POLICY IF EXISTS "Business owners upload contracts" ON storage.objects;
DROP POLICY IF EXISTS "Business owners read contracts" ON storage.objects;

CREATE POLICY "Business owners upload own contracts" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'contracts'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM businesses WHERE owner_id = auth.uid()
    )
  );

CREATE POLICY "Business owners read own contracts" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'contracts'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM businesses WHERE owner_id = auth.uid()
    )
  );

-- Fix business-documents bucket — no policies exist
CREATE POLICY "Business owners manage own documents" ON storage.objects
  FOR ALL USING (
    bucket_id = 'business-documents'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM businesses WHERE owner_id = auth.uid()
    )
  );

-- Service role can access all storage (for webhooks, cron, etc.)
CREATE POLICY "Service role full access contracts" ON storage.objects
  FOR ALL TO service_role USING (bucket_id = 'contracts');

CREATE POLICY "Service role full access documents" ON storage.objects
  FOR ALL TO service_role USING (bucket_id = 'business-documents');
