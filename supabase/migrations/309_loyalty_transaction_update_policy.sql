-- 309: Add missing UPDATE policy on loyalty_transactions
--
-- loyalty_transactions had INSERT policies (owner + service_role) and
-- owner SELECT, but zero UPDATE policies. The bot's redemption flow
-- updates reference_type to store the redemption code for staff verification.
-- The bot uses service_role (which bypasses RLS), but the policy should
-- exist for defense-in-depth and if the mutation path ever changes.

-- Service-role UPDATE (bot redemption code storage)
CREATE POLICY "loyalty_transactions_service_update" ON loyalty_transactions
  FOR UPDATE USING (auth.role() = 'service_role');

-- Owner UPDATE (business owner may need to correct transaction metadata)
CREATE POLICY "loyalty_transactions_owner_update" ON loyalty_transactions
  FOR UPDATE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
