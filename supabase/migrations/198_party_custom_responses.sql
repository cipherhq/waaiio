-- Custom RSVP responses + auto-followup for parties (Growth+ plans)
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS rsvp_yes_message TEXT;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS rsvp_maybe_message TEXT;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS rsvp_no_message TEXT;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS followup_message TEXT;
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS followup_days_before INTEGER DEFAULT 1;

COMMENT ON COLUMN parties.rsvp_yes_message IS 'Custom message shown when guest taps Yes (Growth+ only)';
COMMENT ON COLUMN parties.rsvp_maybe_message IS 'Custom message shown when guest taps Maybe (Growth+ only)';
COMMENT ON COLUMN parties.rsvp_no_message IS 'Custom message shown when guest taps No (Growth+ only)';
COMMENT ON COLUMN parties.followup_message IS 'Auto-followup sent X days before event to confirmed guests';
COMMENT ON COLUMN parties.followup_days_before IS 'Days before event to send followup (default 1)';
