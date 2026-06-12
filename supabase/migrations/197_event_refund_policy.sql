-- Add refund_policy to events (refundable or no_refund)
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS refund_policy VARCHAR(20) NOT NULL DEFAULT 'refundable';

-- Add index for filtering
CREATE INDEX IF NOT EXISTS idx_events_refund_policy ON events(refund_policy);

COMMENT ON COLUMN events.refund_policy IS 'refundable = tickets can be refunded, no_refund = no refunds allowed';
