-- APP-FIRST: apply only after the private verification uploader/viewer is deployed.
-- Old verification files must be copied/verified/removed through Storage APIs;
-- this migration does not relocate objects or certify legacy privacy.
BEGIN;
DROP POLICY IF EXISTS "No new public verification objects" ON storage.objects;
CREATE POLICY "No new public verification objects" ON storage.objects
AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (
  bucket_id <> 'business-documents' OR
  ((storage.foldername(name))[1] IS DISTINCT FROM 'verification' AND
   (storage.foldername(name))[2] IS DISTINCT FROM 'verification')
);
DROP POLICY IF EXISTS "No public verification object updates" ON storage.objects;
CREATE POLICY "No public verification object updates" ON storage.objects
AS RESTRICTIVE FOR UPDATE TO authenticated USING (
  bucket_id <> 'business-documents' OR
  ((storage.foldername(name))[1] IS DISTINCT FROM 'verification' AND
   (storage.foldername(name))[2] IS DISTINCT FROM 'verification')
) WITH CHECK (
  bucket_id <> 'business-documents' OR
  ((storage.foldername(name))[1] IS DISTINCT FROM 'verification' AND
   (storage.foldername(name))[2] IS DISTINCT FROM 'verification')
);
COMMIT;
