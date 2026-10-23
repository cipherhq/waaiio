-- 460_category_sort_order_correction.sql
--
-- Corrective migration for M459 sort_order.
--
-- M459 (459_expand_business_categories.sql) set sort_order alphabetically
-- by KEY within each group. The approved ordering is alphabetical by LABEL.
-- These differ for categories where the key and display label have different
-- alphabetical positions (e.g., key 'salon' → label 'Hair Salon').
--
-- This migration derives sort_order from actual DB labels at execution time,
-- producing correct alphabetical ordering regardless of key/label mismatches.
--
-- Idempotent: safe to re-run. Does not modify any column except sort_order.
-- Preserves all existing businesses, greetings, capabilities, and templates.

WITH ranked AS (
  SELECT key,
         ROW_NUMBER() OVER (ORDER BY category_group, label) - 1 AS new_sort
  FROM category_templates
  WHERE is_active = true
)
UPDATE category_templates ct
SET sort_order = r.new_sort
FROM ranked r
WHERE ct.key = r.key;
