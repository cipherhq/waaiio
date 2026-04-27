-- Add recurring invoice support
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurring_frequency VARCHAR(10) CHECK (recurring_frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),
  ADD COLUMN IF NOT EXISTS recurring_next_date DATE,
  ADD COLUMN IF NOT EXISTS recurring_end_date DATE,
  ADD COLUMN IF NOT EXISTS recurring_parent_id UUID REFERENCES public.invoices(id),
  ADD COLUMN IF NOT EXISTS recurring_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_invoices_recurring ON public.invoices(is_recurring, recurring_next_date)
  WHERE is_recurring = true AND status != 'cancelled';

COMMENT ON COLUMN public.invoices.is_recurring IS 'Whether this invoice auto-generates on a schedule';
COMMENT ON COLUMN public.invoices.recurring_frequency IS 'weekly, biweekly, monthly, quarterly, yearly';
COMMENT ON COLUMN public.invoices.recurring_next_date IS 'Next date to auto-generate invoice';
COMMENT ON COLUMN public.invoices.recurring_parent_id IS 'Links generated invoices back to the recurring template';
COMMENT ON COLUMN public.invoices.recurring_count IS 'Number of invoices generated from this recurring template';
