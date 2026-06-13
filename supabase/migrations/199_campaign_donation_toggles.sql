-- Allow campaigns to keep accepting donations after end date or goal is met
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS allow_after_end_date BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_after_goal_met BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN campaigns.allow_after_end_date IS 'If true, campaign accepts donations even after end_date passes';
COMMENT ON COLUMN campaigns.allow_after_goal_met IS 'If true, campaign accepts donations even after goal_amount is reached';
