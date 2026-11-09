## 2026-11-08 — Pricing wording: fee from day one plus gateway fees; 14-day Pro/Premium trial; correct rates and booking limits

**Why: Owner decisions, 2026-11-08**
- **Fee.** Waaiio's fee is Starter 3%, Pro 1.5%, Premium 1% per paid transaction, matching production `pricing_tiers`. It applies **from sign-up**, and the trial never waives it. It is the same on every route, and Waaiio collects it.
- **Gateway fees.** The business pays every payment-gateway fee; Waaiio absorbs none.
- **Trial.** The 14-day free trial is for Pro and Premium features. It starts at sign-up, Premium limits apply during it, and the fee stays at the business's plan rate.
- **Messaging credit.** The free credit (verify your phone, #955) is separate.
- **Booking limits.** Starter and Pro allow 100 and 1,000 bookings a month.
- **The problem this fixes.** The pricing page read as "no fees". Several pages and emails quoted old rates (2.5%, 1.5% + ₦75) or wrong limits (50, 300, 500) and a 30-day or 7-day trial.

**Ships in the same release as the code lanes.** This PR changes wording plus the booking limits. The code behind the wording is already on main:
- #961 (M525) starts the 14-day feature-trial clock at sign-up, ends it on upgrade, and removes the SQL trial fee waiver.
- #960 removes the app trial fee waiver and applies Premium limits during the trial.
- #959 makes the merchant bear the Paystack fee on splits and charges the plan fee to own-gateway businesses.

The Stripe split, Stripe own-gateway, Flutterwave own-gateway and Paystack Connect routes are known limits that are not in use (standing order, PR #962).

**What changed**
- `app/(marketing)/pricing/page.tsx`
  - **Hero:** "Try every Pro and Premium feature free for 14 days. Starter has no monthly fee: a 3% Waaiio fee applies to each paid transaction from day one, and payment gateway fees are paid by your business."
  - **Starter card note:** the same fee statement.
  - **FAQ "What happens after my trial?":** Pro and Premium features switch off, and the fee is the same before and after the trial.
  - **FAQ "hidden fees":** gateway fees "are paid by your business".
  - **Compare row:** shows "Up to 1,000".
- `lib/constants.ts`
  - The Starter card highlight `TIER_FEATURES.free` is now "14-day trial of Pro & Premium features".
  - `TIER_TRANSACTION_LIMITS` monthly bookings: 50 becomes **100** (Starter) and 300 becomes **1,000** (Pro).
  - This table feeds:
    - the pricing page's "Monthly bookings" row
    - the dashboard usage meter
    - the dashboard upgrade banner
    - `checkTierLimit` in the scheduling bot flow, which now blocks only above 120 (Starter) or 1,200 (Pro) instead of above 60 or 360. The earlier WhatsApp greeting gate (`StandaloneService.checkTierLimitsFromBusiness`, `PRICING_TIERS.maxBookings`) already stopped at 100 / 1,000 WhatsApp bookings and is unchanged. In practice, once its trial has ended, a Starter business is stopped at 100 WhatsApp bookings, or above 120 bookings across all channels. During the trial, Premium limits apply (#960).
  - Orders, tickets, giving and invoice limits are unchanged.
- `components/dashboard/UpgradeBanner.tsx`: the banner assumed a 50-booking Starter limit and said Pro gives "500 bookings". It now reads both limits from `TIER_TRANSACTION_LIMITS`: it warns from 70 bookings, says "limit reached" at 100, and names Pro's 1,000.
- `lib/email/templates.ts`
  - **Old rates removed:** the trial-ending, trial-ended, subscription-expiring and subscription-expired emails quoted 2.5% and 1.5% + ₦75. They now quote 3% / 1.5% / 1%, and the wrong "7-day" trial wording is gone.
  - **Trial emails:** they now say Pro and Premium features switch off and the fee stays the same, instead of fees "starting" after the trial.
  - **Welcome email:** it said "30-day … all features", and now says "14-day … all Pro and Premium features".
- `app/(marketing)/help/page.tsx`: the two FAQ answers now say: 14-day trial of Pro and Premium features for every new business; fee from day one; gateway fees paid by the business.
- `app/dashboard/help/page.tsx`
  - **Before:** "What are the fees?" gave the wrong rates and a 30-day trial.
  - **Now:** Starter 3%, Pro 1.5%, Premium 1%; category rates or a custom agreement may apply; the 14-day feature trial; the fee from day one; gateway fees paid by the business.
- `app/dashboard/payouts/page.tsx`: the fee sentence in the Payout Terms of Use had the same wrong rates. It now points to the Pricing page and lists the current rates. The terms version ("1.0") is not changed.
- `app/api/whatsapp/flow-callback/onboarding.ts`: the WhatsApp sign-up messages and the welcome email said "30-day trial … all features", and the Pro upsell said "500 bookings". They now say a 14-day trial of Pro and Premium features, and 1,000 bookings.
- `app/get-started/steps/StepPlan.tsx`: the sign-up plan picker said Starter's fee applies "after trial" and labelled Starter a "free trial". It now says "no monthly fee", that the fee applies "from day one, plus payment gateway fees", and that every Pro and Premium feature can be tried free for 14 days.
- Smaller copy:
  - `app/(marketing)/blog/posts.ts`: both trial lines now name Pro and Premium features.
  - `lib/constants.ts`: unused Starter feature strings no longer say "no fees" or "after trial", and the Pro and Premium "Direct bank transfer" strings now say "(zero gateway fees)", matching `TIER_FEATURES`.
  - The WhatsApp upsell keeps "Upgrade anytime to get:". The trial never changes the fee.
  - The trial emails now say "keep the features you use" and "your per-transaction fee stays the same", so they hold for custom or category rates too.
  - `app/dashboard/page.tsx`: the bookings usage-meter fallback is now the Starter limit.
- `app/dashboard/capabilities/page.tsx`: the in-trial note now says the 14-day trial includes every Pro and Premium feature.
- Test: `lib/__tests__/pricing-trial-fee-wording.test.tsx` checks:
  - the rendered pricing page (wording, the absence of "no fees", the booking row)
  - the rendered upgrade banner at 60, 75 and 100 bookings
  - the four plan emails
  - that the booking limits agree everywhere
  - Also: `lib/__tests__/signup-plan-choice.test.tsx` now checks the plan picker's fee line.
  - Also: `lib/__tests__/onboarding-wizard-pricing-lifecycle.test.ts` now picks the Premium card by its name (`/^Premium/`), because the Starter card's new trial line mentions Premium. `signup-plan-choice` gets a 15-second timeout, because the page is slow to render.

**Unchanged:**
- Fee rates, and how fees are calculated. `calculateFee` has had no trial or own-gateway shortcut since #959 and #960.
- Trial length (`trial_days` = 14), payment routing, and all other limits.

**Could break:**
- A Starter or Pro business near 50 or 300 bookings can now take bookings up to the new limits, and the upgrade banner no longer shows at 35–69 Starter bookings.
- `public/llms.txt`, the summary page for AI search tools, said "30-day free trial with all features, then 2.5% per transaction". It now gives the current model.
- Several pages and emails now state the fee rates and the 14-day trial as fixed text. If the rates or `trial_days` change in settings, update them too.
