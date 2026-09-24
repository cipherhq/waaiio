-- #376: Fixed-price deposit authority.
--
-- Existing production data may contain legacy invalid rows (for example,
-- appointment price 100 / deposit 200). NOT VALID avoids blocking deployment
-- on those historical rows while still enforcing the invariant for every new
-- INSERT/UPDATE. Runtime payment code independently guards legacy rows.
--
-- Variable-price offerings are excluded from the upper-bound check because
-- their configured price is a starting price, not the final transaction total.

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_deposit_amount_authority_chk
  CHECK (
    COALESCE(deposit_amount, 0) >= 0
    AND (
      COALESCE(price_is_variable, false)
      OR COALESCE(deposit_amount, 0) <= GREATEST(COALESCE(price, 0), 0)
    )
  ) NOT VALID;

ALTER TABLE public.services
  ADD CONSTRAINT services_deposit_amount_authority_chk
  CHECK (
    COALESCE(deposit_amount, 0) >= 0
    AND (
      COALESCE(price_is_variable, false)
      OR COALESCE(deposit_amount, 0) <= GREATEST(COALESCE(price, 0), 0)
    )
  ) NOT VALID;
