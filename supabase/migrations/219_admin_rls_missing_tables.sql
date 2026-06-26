-- Fix: Several tables missing admin SELECT policy — admin panel shows empty data

-- event_tickets (68 records invisible to admin)
CREATE POLICY "Admin reads event tickets" ON event_tickets
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'support', 'finance', 'operations'))
  );

-- event_invites
CREATE POLICY "Admin reads event invites" ON event_invites
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'support', 'operations'))
  );

-- invoices
CREATE POLICY "Admin reads invoices" ON invoices
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'support', 'finance'))
  );

-- parties
CREATE POLICY "Admin reads parties" ON parties
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'support', 'operations'))
  );

-- reservations
CREATE POLICY "Admin reads reservations" ON reservations
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'support', 'operations'))
  );
