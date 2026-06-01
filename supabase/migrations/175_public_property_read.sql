-- Allow public read access to active properties (for /property/[id] public page)
-- Only exposes properties where is_active = true AND the business is also active
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'properties' AND policyname = 'public_read_active_properties') THEN
    CREATE POLICY public_read_active_properties ON properties FOR SELECT TO anon, authenticated
      USING (
        is_active = true
        AND business_id IN (SELECT id FROM businesses WHERE is_active = true AND status = 'active')
      );
  END IF;
END $$;
