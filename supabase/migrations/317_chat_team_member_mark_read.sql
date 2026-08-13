-- P1-CHAT-1: Allow team members to mark chat messages as read
--
-- Team members (business_members with status='active') can SELECT and INSERT
-- into chat_messages (migration 168), but cannot UPDATE — so the Dashboard
-- markAsRead function silently fails for team members.
--
-- This migration adds a team-member UPDATE policy scoped to the same
-- business_members authorization used by existing team-member policies.

-- Team members can update chat messages for their authorized businesses
CREATE POLICY "team_members_update_messages"
  ON chat_messages
  FOR UPDATE
  USING (
    business_id IN (
      SELECT business_id FROM business_members
      WHERE user_id = auth.uid() AND status = 'active'
    )
  )
  WITH CHECK (
    business_id IN (
      SELECT business_id FROM business_members
      WHERE user_id = auth.uid() AND status = 'active'
    )
  );
