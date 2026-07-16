-- =============================================
-- Fix ATT-01: Remove unsafe INSERT policy
-- The "service_insert" WITH CHECK (true) allows any role to insert.
-- Service role already bypasses RLS, so this policy is unnecessary and dangerous.
-- =============================================

DROP POLICY IF EXISTS "service_insert" ON attendance_log;

-- =============================================
-- Fix ATT-02: Add column constraints
-- =============================================

ALTER TABLE attendance_log
  ADD CONSTRAINT chk_attendance_name_length CHECK (length(customer_name) <= 200),
  ADD CONSTRAINT chk_attendance_phone_length CHECK (customer_phone IS NULL OR length(customer_phone) <= 30),
  ADD CONSTRAINT chk_attendance_email_length CHECK (customer_email IS NULL OR length(customer_email) <= 320),
  ADD CONSTRAINT chk_attendance_notes_length CHECK (notes IS NULL OR length(notes) <= 2000),
  ADD CONSTRAINT chk_attendance_source CHECK (source IN ('web', 'whatsapp', 'manual'));

-- =============================================
-- Fix ATT-03: Add admin RLS policy
-- Admin and operations roles can read all attendance for monitoring
-- =============================================

CREATE POLICY "admin_ops_read" ON attendance_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'operations')
    )
  );
