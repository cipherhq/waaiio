-- Track which API key created an event (NULL = dashboard-created)
ALTER TABLE events ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_events_api_key_id ON events(api_key_id) WHERE api_key_id IS NOT NULL;
