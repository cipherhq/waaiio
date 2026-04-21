-- Per-event ticket purchase limit (NULL = use business-level default)
ALTER TABLE public.events ADD COLUMN max_per_order INTEGER;
