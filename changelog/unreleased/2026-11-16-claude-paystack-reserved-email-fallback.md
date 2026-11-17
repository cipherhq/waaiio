## 2026-11-16 — Paystack never receives a reserved test-domain payer email (#1062 follow-up)

- `lib/payments/paystack.ts`: on own-account (BYO) and Connect routes, a `userEmail` on a reserved domain (`.invalid`, `.test`, `.example`, `.localhost`) is treated as no email and the existing internal phone alias is sent instead. Covers, in one place, every caller that can reach a merchant own-account/Connect route: web Request Balance (stored booking email), invoice pay, donations, and bot bookings started before #1064 where the customer types *skip*. Pay links and recurring setup always use the shared route and already sent the alias.
- `lib/bot/flows/shared/user.ts`: `isReservedEmailDomain` ignores trailing dots (`a@x.invalid.`).
- Unchanged: shared Waaiio Paystack (always alias), real emails on BYO/Connect, splits/fees, Stripe/Flutterwave/Square/PayPal.
- Could break: a merchant's own Paystack dashboard shows the phone alias instead of a reserved test address for those payments (previously Paystack rejected the request; #1062).
