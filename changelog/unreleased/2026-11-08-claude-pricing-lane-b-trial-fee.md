## 2026-11-08 — Trial starts at sign-up; the Waaiio fee is never waived

**Why:** Owner pricing decisions (2026-11-08, issue #958). The Waaiio fee (Starter 3%, Pro 1.5%, Premium 1%) applies from sign-up and the free trial never waives it. The 14-day free trial is for Pro and Premium features, starts at sign-up for every new business, uses Premium limits, and is separate from the free messaging credit and from `messaging_financial_gate`. Before this change the code waived the fee during a trial, and the trial only started with the messaging-credit grant, so nobody got the 14-day trial.

**What changed**
- Depends on migration M525 (PR #961, merged and applied first): `businesses.feature_trial_ends_at` is the Pro/Premium trial clock, set at sign-up; `trial_ends_at` stays the messaging-credit clock; the recurring SQL fee path no longer waives.
- Fee code: `lib/payments/calculateFee.ts`, `lib/getPlatformFees.ts`, `lib/constants.ts` (`calculatePlatformFee`) no longer return 0 in a trial. `lib/bot/flows/shared/payment.ts` records `waived: false`. The payouts balance estimate (`app/api/payouts/balance/route.ts`, added by #959) uses the new trial check. `is_in_trial` is still recorded on the fee basis, for reporting only.
- Trial status: `lib/trial-status.ts` (`resolveFeatureTrialEndsAt`, `resolveTrialStatus`, `resolveLimitTier`), `lib/capabilities/policy.ts` (`isTrialActive` no longer needs credit; new `getLimitTier`). Capability callers read the feature clock: dashboard layout, capabilities configure, giving save, recurring offer, API guard, bot capability guard, bot service.
- Premium limits during the trial: `lib/tier-limits.ts`, `lib/bot/standalone.service.ts` (bot booking cap / greeting gate), `lib/bot/conversation-guard.ts`, broadcasts send/schedule/usage, dashboard home usage bars and upgrade banner (`app/dashboard/page.tsx` passes the limit tier), and the billing page.
- Trial emails: `app/api/cron/trial-check` uses the feature clock and only Starter businesses.
- Tests: `lib/__tests__/pricing-lane-b-trial-fee.test.ts` (new), `lib/__tests__/pricing-lane-b-upgrade-banner.test.tsx` (new), updated trial/fee/capability tests (the M525 pg test is in PR #961).

**Unchanged:** fee rates, payment routing and custody (both routes), lane C's own-gateway fee and gateway-fee rules (#959), the messaging credit (`activate_trial_if_eligible`, `/dashboard/claim-credit`, the trial-activation cron), existing businesses (no backfill — they do not get a trial).

**What could break**
- Pro/Premium features now unlock for every new Starter business for 14 days, and switch off after.
- Businesses in a trial now pay the Waaiio fee.
- The admin "extend trial" button still writes `trial_ends_at` (the credit clock), not the feature clock (follow-up).
