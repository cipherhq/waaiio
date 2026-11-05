-- Additive verification storage; deploy private uploader/viewer after this migration.
-- Public catalog media stays in business-documents. No object metadata moves.
BEGIN;
INSERT INTO storage.buckets(id, name, public)
VALUES ('verification-documents', 'verification-documents', false)
ON CONFLICT (id) DO UPDATE SET public = false;
DROP POLICY IF EXISTS "Service manages verification documents" ON storage.objects;
CREATE POLICY "Service manages verification documents" ON storage.objects
FOR ALL TO service_role USING (bucket_id = 'verification-documents')
WITH CHECK (bucket_id = 'verification-documents');

-- Signed bearer links are served by Storage; they do not require public SELECT.
UPDATE storage.buckets SET public = false WHERE id IN ('documents', 'customer-reports');
DROP POLICY IF EXISTS "Allow public reads on documents" ON storage.objects;
DROP POLICY IF EXISTS "Business owners read reports" ON storage.objects;
DROP POLICY IF EXISTS "Business owners upload reports" ON storage.objects;
DROP POLICY IF EXISTS "Business owners delete reports" ON storage.objects;
CREATE POLICY "Business owners read reports" ON storage.objects
FOR SELECT TO authenticated USING (
  bucket_id = 'customer-reports' AND (storage.foldername(name))[1] IN
    (SELECT id::text FROM public.businesses WHERE owner_id = (SELECT auth.uid()))
);
CREATE POLICY "Business owners upload reports" ON storage.objects
FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'customer-reports' AND (storage.foldername(name))[1] IN
    (SELECT id::text FROM public.businesses WHERE owner_id = (SELECT auth.uid()))
);
CREATE POLICY "Business owners delete reports" ON storage.objects
FOR DELETE TO authenticated USING (
  bucket_id = 'customer-reports' AND (storage.foldername(name))[1] IN
    (SELECT id::text FROM public.businesses WHERE owner_id = (SELECT auth.uid()))
);
-- Generated receipts/user and receipts/business paths remain service-only;
-- existing service policies and signed URL generation are unchanged.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id IN ('verification-documents','documents','customer-reports') AND public) THEN
    RAISE EXCEPTION 'Private document bucket unexpectedly public';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='storage.objects'::regclass) THEN
    RAISE EXCEPTION 'Storage RLS disabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privilege_name
    WHERE NOT has_table_privilege('service_role','storage.objects',privilege_name)
  ) THEN
    RAISE EXCEPTION 'Service storage privileges missing';
  END IF;
END $$;
COMMIT;
