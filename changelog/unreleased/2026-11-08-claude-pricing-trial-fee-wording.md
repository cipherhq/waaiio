## 2026-11-08 — Pricing wording: trial waives only the platform fee; correct fee rates and booking limits

**Why (Owner, 2026-11-08):**
- The pricing page read as "no fees" although Waaiio charges a platform fee after the trial. The Owner confirmed the Starter fee is 3% (production `pricing_tiers`: Starter 3%, Pro 1.5%, Premium 1%), so the rates themselves are unchanged.
- The Owner confirmed Starter and Pro allow 100 and 1,000 bookings a month, which matches `PRICING_TIERS.maxBookings` and production `pricing_tiers.maxBookings`.

**What changed**
- `app/(marketing)/pricing/page.tsx`, hero line. Was "14-day free trial with zero fees, then 3% standard platform fee." Now "14-day free trial with no Waaiio platform fee, then a 3% standard platform fee on each paid transaction." The numbers still come from `/api/public/pricing`.
- `lib/constants.ts`:
  - The Starter card highlight `TIER_FEATURES.free` changes from "Free trial (no fees)" to "Free trial (no platform fee)".
  - `TIER_TRANSACTION_LIMITS` monthly bookings change from 50 to **100** (Starter) and from 300 to **1,000** (Pro). This table feeds the pricing page's "Monthly bookings" row (now shown as "Up to 1,000"), the dashboard usage meter, the dashboard upgrade banner, and `checkTierLimit` in the scheduling bot flow, which now blocks booking only above 120 (Starter) or 1,200 (Pro) instead of 60 or 360. Orders, tickets, giving and invoice limits are unchanged.
- `components/dashboard/UpgradeBanner.tsx`: the banner assumed a 50-booking Starter limit and said Pro gives "500 bookings". It now reads both limits from `TIER_TRANSACTION_LIMITS`, so it warns from 70 bookings (70% of 100), shows "limit reached" at 100, and names Pro's 1,000.
- `lib/email/templates.ts`: four plan emails quoted the old rates (Starter 2.5%, Premium 1.5% + ₦75). They now say Starter 3%, Pro 1.5% and Premium 1%. Two of them also called the trial "7-day"; that number is removed.
  - trial ending (`trialExpiringEmail`)
  - trial ended (`trialEndedEmail`)
  - subscription expiring (`subscriptionExpiringEmail`)
  - subscription expired (`subscriptionExpiredEmail`)
- `app/(marketing)/help/page.tsx`: the two FAQ answers say the trial has no Waaiio platform fee instead of "zero fees".
- `app/dashboard/help/page.tsx`: the "What are the fees?" answer had the wrong rates (Starter 2.5%, Premium 1.5% + ₦75) and a 30-day trial. It now gives Starter 3%, Pro 1.5% and Premium 1%, notes that category rates or a custom agreement may apply, mentions a free trial with no platform fee, and says gateway fees are separate.
- `app/dashboard/payouts/page.tsx`: the fee sentence in the Payout Terms of Use had the same wrong rates. It now points to the Pricing page, with the current rates (3%, 1.5%, 1%). The terms version ("1.0") is not changed.
- `app/api/whatsapp/flow-callback/onboarding.ts`: the WhatsApp sign-up upsell said Pro allows "Up to 500 bookings/month"; it now says 1,000. Its "30-day trial" wording is unchanged and still waits on an Owner decision.
- Test: `lib/__tests__/pricing-trial-fee-wording.test.tsx` checks:
  - the pricing page (wording and booking row), rendered;
  - the upgrade banner at 60, 75 and 100 bookings, rendered;
  - the four plan emails;
  - that the booking limits agree.

**Unchanged:** fee rates, how fees are calculated (`calculateFee`, in order: bring-your-own gateway 0%, trial 0%, the business's custom rate, the category rate, then the tier rate; production has no custom or category rates today), the trial length (`trial_days` = 14), and all other limits.

**Could break:**
- A Starter or Pro business that was blocked or warned near 50 or 300 bookings can now take bookings up to the new limits.
- The upgrade banner no longer shows at 35–69 Starter bookings.
- The dashboard help page, payout terms and plan emails now state the fee rates as text. If the rates change in settings, these lines must be updated too.
