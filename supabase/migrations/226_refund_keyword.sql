-- Add "refund" / "request refund" keyword to system bot keywords
INSERT INTO public.bot_keywords (keyword, match_type, action_type, payload, is_active, priority, scope, description)
VALUES
  ('^(refund|request refund|refund request|i want a refund|i need a refund)$', 'regex', 'navigate_step',
   '{"action":"request_refund"}', true, 85, 'system',
   'Refund request - lets customer request a refund for a recent payment');
