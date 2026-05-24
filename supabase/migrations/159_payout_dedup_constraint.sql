-- Prevent duplicate payouts for the same business and period
-- (guards against cron double-run or admin double-click)
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_payouts_period_unique
  ON business_payouts (business_id, period_start, period_end)
  WHERE status NOT IN ('rejected', 'failed');
