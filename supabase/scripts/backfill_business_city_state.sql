-- backfill_business_city_state.sql
--
-- Backfill city and state columns for businesses where city IS NULL
-- but the address text contains a known city name from COUNTRIES data.
--
-- This is a SCRIPT, not a migration. Run manually after review.
-- Step 1: Dry-run SELECT to preview affected rows.
-- Step 2: (Commented out) UPDATE to apply the backfill.

-- ═══════════════════════════════════════════════════════
-- STEP 1 — DRY RUN: Preview businesses that would be updated
-- ═══════════════════════════════════════════════════════

WITH known_cities (city_name, state_name, country_code) AS (
  VALUES
    -- Nigeria
    ('Lagos',          'Lagos',          'NG'),
    ('Abuja',          'FCT',            'NG'),
    ('Port Harcourt',  'Rivers',         'NG'),
    -- United States
    ('New York',       'New York',       'US'),
    ('Los Angeles',    'California',     'US'),
    ('Houston',        'Texas',          'US'),
    ('Atlanta',        'Georgia',        'US'),
    -- United Kingdom
    ('London',         'England',        'GB'),
    ('Manchester',     'England',        'GB'),
    ('Birmingham',     'England',        'GB'),
    -- Canada
    ('Toronto',        'Ontario',        'CA'),
    ('Calgary',        'Alberta',        'CA'),
    ('Vancouver',      'British Columbia','CA'),
    -- Ghana
    ('Accra',          'Greater Accra',  'GH'),
    ('Kumasi',         'Ashanti',        'GH'),
    ('Tema',           'Greater Accra',  'GH')
)
SELECT
  b.id,
  b.name,
  b.address,
  b.city        AS current_city,
  b.state       AS current_state,
  kc.city_name  AS proposed_city,
  kc.state_name AS proposed_state,
  kc.country_code
FROM businesses b
JOIN known_cities kc
  ON b.address ILIKE '%' || kc.city_name || '%'
WHERE b.city IS NULL
  AND b.address IS NOT NULL
  AND b.status = 'active'
ORDER BY kc.country_code, kc.city_name, b.name;


-- ═══════════════════════════════════════════════════════
-- STEP 2 — UPDATE: Uncomment to apply the backfill
-- ═══════════════════════════════════════════════════════
-- IMPORTANT: Review the dry-run output above before running.
-- If a business address matches multiple cities (unlikely), the
-- DISTINCT ON ensures only one update per business, preferring
-- the longest city name match (e.g., "Port Harcourt" over "Port").

/*
WITH known_cities (city_name, state_name, country_code) AS (
  VALUES
    -- Nigeria
    ('Lagos',          'Lagos',          'NG'),
    ('Abuja',          'FCT',            'NG'),
    ('Port Harcourt',  'Rivers',         'NG'),
    -- United States
    ('New York',       'New York',       'US'),
    ('Los Angeles',    'California',     'US'),
    ('Houston',        'Texas',          'US'),
    ('Atlanta',        'Georgia',        'US'),
    -- United Kingdom
    ('London',         'England',        'GB'),
    ('Manchester',     'England',        'GB'),
    ('Birmingham',     'England',        'GB'),
    -- Canada
    ('Toronto',        'Ontario',        'CA'),
    ('Calgary',        'Alberta',        'CA'),
    ('Vancouver',      'British Columbia','CA'),
    -- Ghana
    ('Accra',          'Greater Accra',  'GH'),
    ('Kumasi',         'Ashanti',        'GH'),
    ('Tema',           'Greater Accra',  'GH')
),
ranked_matches AS (
  SELECT DISTINCT ON (b.id)
    b.id,
    kc.city_name,
    kc.state_name
  FROM businesses b
  JOIN known_cities kc
    ON b.address ILIKE '%' || kc.city_name || '%'
  WHERE b.city IS NULL
    AND b.address IS NOT NULL
    AND b.status = 'active'
  ORDER BY b.id, length(kc.city_name) DESC
)
UPDATE businesses b
SET
  city  = rm.city_name,
  state = rm.state_name
FROM ranked_matches rm
WHERE b.id = rm.id;
*/
