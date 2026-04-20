-- Backfill: Add 'ticketing' capability for existing church/mosque businesses
-- that already have business_capabilities rows but are missing ticketing.
-- This ensures the dashboard and bot stay in sync after adding ticketing to defaults.

INSERT INTO public.business_capabilities (business_id, capability, is_enabled)
SELECT b.id, 'ticketing', true
FROM public.businesses b
WHERE b.category IN ('church', 'mosque')
  AND NOT EXISTS (
    SELECT 1 FROM public.business_capabilities bc
    WHERE bc.business_id = b.id AND bc.capability = 'ticketing'
  )
ON CONFLICT (business_id, capability) DO NOTHING;
