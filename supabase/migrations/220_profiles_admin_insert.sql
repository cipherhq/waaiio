-- Fix: Admin cannot create placeholder profiles for new team members
-- The AdminTeam page inserts a profile with role + email before the user signs up

CREATE POLICY "Admin inserts team profiles" ON profiles
  FOR INSERT WITH CHECK (
    is_admin()
  );
