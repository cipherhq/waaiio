-- Allow business owners to read their own LLM classification logs
-- Needed for the Bot Performance analytics section on the dashboard
CREATE POLICY "Business owner read access" ON llm_classifications
  FOR SELECT USING (
    business_id IN (
      SELECT id FROM businesses WHERE owner_id = auth.uid()
    )
  );
