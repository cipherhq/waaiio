-- Create documents storage bucket for ticket PDFs and generated documents
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- Service role can upload (bot uses service client), allow public signed-URL reads
CREATE POLICY "Allow service role uploads on documents"
ON storage.objects FOR INSERT TO service_role
WITH CHECK (bucket_id = 'documents');

CREATE POLICY "Allow service role all on documents"
ON storage.objects FOR ALL TO service_role
USING (bucket_id = 'documents');

-- Allow public to read via signed URLs
CREATE POLICY "Allow public reads on documents"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'documents');
