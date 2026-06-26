-- Fix: Admin cannot create/manage resellers — missing RLS policy
-- The admin panel uses the anon client with admin session, not service_role

CREATE POLICY "Admin manages resellers" ON resellers
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin'))
  );
