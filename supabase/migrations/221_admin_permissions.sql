-- Admin role permissions matrix
-- Each role gets granular read/write permissions per resource
CREATE TABLE IF NOT EXISTS admin_role_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT NOT NULL, -- admin, support, finance, operations
  resource TEXT NOT NULL, -- e.g. businesses, bookings, payments, payouts, events, tickets, etc.
  can_read BOOLEAN NOT NULL DEFAULT true,
  can_write BOOLEAN NOT NULL DEFAULT false, -- create/update
  can_delete BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(role, resource)
);

ALTER TABLE admin_role_permissions ENABLE ROW LEVEL SECURITY;

-- Only admin can manage permissions
CREATE POLICY "Admin manages permissions" ON admin_role_permissions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- All admin roles can read permissions (to check their own access)
CREATE POLICY "Admin roles read permissions" ON admin_role_permissions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'support', 'finance', 'operations'))
  );

-- Seed default permissions
INSERT INTO admin_role_permissions (role, resource, can_read, can_write, can_delete) VALUES
  -- Admin: full access to everything
  ('admin', 'businesses', true, true, true),
  ('admin', 'bookings', true, true, true),
  ('admin', 'payments', true, true, true),
  ('admin', 'payouts', true, true, true),
  ('admin', 'events', true, true, true),
  ('admin', 'tickets', true, true, true),
  ('admin', 'orders', true, true, true),
  ('admin', 'invoices', true, true, true),
  ('admin', 'subscriptions', true, true, true),
  ('admin', 'whatsapp_channels', true, true, true),
  ('admin', 'team', true, true, true),
  ('admin', 'settings', true, true, true),
  ('admin', 'resellers', true, true, true),
  ('admin', 'transfers', true, true, true),
  ('admin', 'campaigns', true, true, true),
  ('admin', 'bot', true, true, true),
  ('admin', 'verification', true, true, true),
  -- Support: read most things, write bookings/tickets/chat
  ('support', 'businesses', true, true, false),
  ('support', 'bookings', true, true, false),
  ('support', 'payments', true, false, false),
  ('support', 'payouts', false, false, false),
  ('support', 'events', true, true, false),
  ('support', 'tickets', true, true, false),
  ('support', 'orders', true, true, false),
  ('support', 'invoices', true, false, false),
  ('support', 'subscriptions', true, false, false),
  ('support', 'whatsapp_channels', true, false, false),
  ('support', 'team', false, false, false),
  ('support', 'settings', false, false, false),
  ('support', 'resellers', false, false, false),
  ('support', 'transfers', true, true, false),
  ('support', 'campaigns', true, false, false),
  ('support', 'bot', true, true, false),
  ('support', 'verification', true, true, false),
  -- Finance: read/write payments + payouts + revenue
  ('finance', 'businesses', true, false, false),
  ('finance', 'bookings', true, false, false),
  ('finance', 'payments', true, true, false),
  ('finance', 'payouts', true, true, false),
  ('finance', 'events', true, false, false),
  ('finance', 'tickets', true, false, false),
  ('finance', 'orders', true, false, false),
  ('finance', 'invoices', true, true, false),
  ('finance', 'subscriptions', true, true, false),
  ('finance', 'whatsapp_channels', false, false, false),
  ('finance', 'team', false, false, false),
  ('finance', 'settings', false, false, false),
  ('finance', 'resellers', true, false, false),
  ('finance', 'transfers', true, true, false),
  ('finance', 'campaigns', true, false, false),
  ('finance', 'bot', false, false, false),
  ('finance', 'verification', true, false, false),
  -- Operations: read/write businesses + bookings + events + bot
  ('operations', 'businesses', true, true, false),
  ('operations', 'bookings', true, true, false),
  ('operations', 'payments', true, false, false),
  ('operations', 'payouts', false, false, false),
  ('operations', 'events', true, true, false),
  ('operations', 'tickets', true, true, false),
  ('operations', 'orders', true, true, false),
  ('operations', 'invoices', true, false, false),
  ('operations', 'subscriptions', true, false, false),
  ('operations', 'whatsapp_channels', true, true, false),
  ('operations', 'team', false, false, false),
  ('operations', 'settings', false, false, false),
  ('operations', 'resellers', false, false, false),
  ('operations', 'transfers', true, true, false),
  ('operations', 'campaigns', true, true, false),
  ('operations', 'bot', true, true, false),
  ('operations', 'verification', true, true, false)
ON CONFLICT (role, resource) DO NOTHING;
