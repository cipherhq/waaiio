-- Allow business owners to read their own AI classification logs
CREATE POLICY "owners_read_own" ON ai_classification_log FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
