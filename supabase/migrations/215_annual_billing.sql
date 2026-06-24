-- Annual billing support
-- billing_interval column already exists on subscriptions (TEXT DEFAULT 'month')
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS chk_billing_interval;
ALTER TABLE subscriptions ADD CONSTRAINT chk_billing_interval CHECK (billing_interval IN ('month', 'year'));
