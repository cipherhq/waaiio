-- 456: Guest tags for party invites — Phase B1-1 (#661)
-- Adds freeform tag array to event_invites for guest categorization
-- (e.g., "Groom's friends", "Bride's family", "VIP", "Table 5")

-- 1. Add tags column with empty array default
ALTER TABLE public.event_invites
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- 2. GIN index for efficient tag-based filtering (array containment queries)
CREATE INDEX IF NOT EXISTS idx_event_invites_tags
  ON public.event_invites USING GIN (tags)
  WHERE tags != '{}';
