## 2026-11-09 — Fee and trial model written down as an Owner standing order

- **Why:** the Owner asked on 2026-11-09 that every financial decision live in the engineering documentation as a standing order that nothing may change.
- **What changed:**
  - `docs/MERCHANT_PAYMENT_CUSTODY_POLICY.md` has a new section, "Waaiio fee and trial model — Owner standing order". It records:
    - the fee per plan from sign-up, the same on every route;
    - the merchant paying all gateway fees, with Waaiio absorbing none;
    - the 14-day Pro/Premium trial at sign-up with Premium limits;
    - upgrade ending the trial;
    - the separate free credit;
    - the booking limits;
    - the known limits that must be fixed before use: Stripe split payments, the own-Stripe setup, the Flutterwave own-gateway split, Paystack Connect, and monthly-invoice double billing;
    - the evidence required for any fee-related change.
  - `CLAUDE.md` has a short summary under the payment custody section that points to it.
  - Source: issue #958; PRs #959, #960, #961.
- **Affects:** documentation only. No code, configuration or database change.
- **Could break:** nothing at runtime. From now on, any PR that contradicts these rules must be stopped for an Owner decision.
