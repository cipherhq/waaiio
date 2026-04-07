-- 013_business_dashboard_rls.sql
-- RLS policies so business owners can access their own support tickets, messages, and bot sessions

-- Support tickets: business owners can manage their own tickets
CREATE POLICY "Business owners can view own tickets"
  ON public.support_tickets FOR SELECT
  USING (requester_id = auth.uid());

CREATE POLICY "Business owners can create tickets"
  ON public.support_tickets FOR INSERT
  WITH CHECK (requester_id = auth.uid());

CREATE POLICY "Business owners can update own tickets"
  ON public.support_tickets FOR UPDATE
  USING (requester_id = auth.uid());

-- Support ticket messages: access messages on own tickets
CREATE POLICY "Business owners can view messages on own tickets"
  ON public.support_ticket_messages FOR SELECT
  USING (ticket_id IN (SELECT id FROM public.support_tickets WHERE requester_id = auth.uid()));

CREATE POLICY "Business owners can add messages to own tickets"
  ON public.support_ticket_messages FOR INSERT
  WITH CHECK (ticket_id IN (SELECT id FROM public.support_tickets WHERE requester_id = auth.uid()));

-- Bot sessions: business owners can view their own business sessions
CREATE POLICY "Business owners can view own bot sessions"
  ON public.bot_sessions FOR SELECT
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
