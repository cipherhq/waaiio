-- Auto-upgrade membership tier when customer total_spent crosses a tier threshold
-- Fires as BEFORE UPDATE trigger so it modifies the row in-place (no extra UPDATE)

CREATE OR REPLACE FUNCTION auto_upgrade_membership_tier()
RETURNS TRIGGER AS $$
DECLARE
  v_new_tier_id UUID;
  v_new_tier_name TEXT;
BEGIN
  -- Only fire when total_spent actually increased
  IF NEW.total_spent IS NULL OR NEW.total_spent <= COALESCE(OLD.total_spent, 0) THEN
    RETURN NEW;
  END IF;

  -- Find the highest tier the customer qualifies for
  SELECT id, name INTO v_new_tier_id, v_new_tier_name
  FROM membership_tiers
  WHERE business_id = NEW.business_id
    AND is_active = true
    AND min_spend <= NEW.total_spent
  ORDER BY min_spend DESC
  LIMIT 1;

  -- No qualifying tier found (business has no tiers or spend too low)
  IF v_new_tier_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only upgrade, never downgrade
  IF NEW.membership_tier_id IS NULL OR
     v_new_tier_id != NEW.membership_tier_id
  THEN
    -- Verify it's actually a higher tier (not a downgrade)
    IF NEW.membership_tier_id IS NULL OR
       (SELECT min_spend FROM membership_tiers WHERE id = v_new_tier_id) >
       COALESCE((SELECT min_spend FROM membership_tiers WHERE id = NEW.membership_tier_id), 0)
    THEN
      NEW.membership_tier_id := v_new_tier_id;
      NEW.tier_earned_at := NOW();
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';
