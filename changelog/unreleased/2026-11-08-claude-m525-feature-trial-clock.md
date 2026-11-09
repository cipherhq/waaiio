## 2026-11-08 — M525: feature-trial clock from sign-up; recurring SQL fee path never waives

**Why:** Owner pricing decisions (2026-11-08, issue #958): the Waaiio fee applies from sign-up and the trial never waives it; the 14-day Pro/Premium trial starts at sign-up, separate from the free messaging credit. Release Gate V2 §9.2: the migration ships ahead of the app change (PR #960) in its own PR.

**What changed**
- `supabase/migrations/525_feature_trial_clock_and_no_trial_fee_waiver.sql` (new):
  - `businesses.feature_trial_ends_at`, the Pro/Premium trial clock. `trial_ends_at` stays the messaging-credit clock.
  - BEFORE INSERT trigger: every new business gets `now() + platform_settings.trial_days` (supplied values ignored; missing or invalid `trial_days` gives no trial and does not block sign-up).
  - BEFORE UPDATE trigger: only the server (service role / function owner) may change the clock.
  - The recurring fee functions (`finalize_token/stripe/paystack_recurring_charge`, `process_recurring_charge` where present) no longer waive the fee: only the `v_is_in_trial := …` statement becomes `false`, in place, keeping each live body, SECURITY DEFINER, search path, owner and grants. The migration fails if a finalizer still reads `trial_ends_at` without that change.
- `supabase/catalog-deltas/525_….json`: catalog effect.
- Tests: `lib/__tests__/feature-trial-clock-525.pg.test.ts` (new, in CI's pg job); `stripe-recurring-finalization-db` case s now expects the plan fee in a trial; `trial-lifecycle-db` adds a case that the sign-up clock neither blocks nor doubles the credit grant.
- `docs/MIGRATION_REGISTRY.md`: 525 reserved; next is 526.

**Unchanged:** `activate_trial_if_eligible` and the messaging credit, fee rates, routing and custody, BYO rule, existing rows (no backfill).

**What could break**
- Recurring charges for a business whose credit clock is in the future are now charged the plan fee (none in production today).
- The M501 accounting activation procedure fails closed (unknown recurring precursor) until its precursor table and stored bodies are updated in the accounting lane.
- With only this migration live, the app still reads the old trial rule; PR #960 switches it to the new clock.
