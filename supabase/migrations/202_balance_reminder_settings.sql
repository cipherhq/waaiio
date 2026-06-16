-- Business-level toggle for balance payment reminders
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS send_balance_reminders BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS include_payment_links BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN whatsapp_config.send_balance_reminders IS 'If true, cron sends balance payment reminders before appointments/check-ins';
COMMENT ON COLUMN whatsapp_config.include_payment_links IS 'If true, balance reminders include a pay-now link';
