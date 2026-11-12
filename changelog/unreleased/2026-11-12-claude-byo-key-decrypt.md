## 2026-11-12 — Merchant-connected Paystack checkout and refunds use the decrypted key

- **What changed:** For businesses connected with their own Paystack/Flutterwave keys (BYO), the stored secret key (encrypted at rest) was passed to the provider without decrypting it. Paystack rejected checkout with `invalid_Key`, so the bot showed bank transfer only (staging, TestBiz booking WA-BK-8012). Routing now decrypts the key before checkout; refund dispatch and refund reconciliation decrypt it too.
- **Files:** `lib/payments/resolve-stripe-routing.ts`, `lib/payments/refund-handler.ts`; tests in `lib/payments/__tests__/byo-key-decrypt.test.ts` and `lib/payments/__tests__/refund-handler.test.ts`.
- **Affects:** BYO checkout links in every bot flow that uses the shared `initializePayment`, and BYO refunds. Platform, platform-subaccount and Connect routes are unchanged. No fee, split or custody rule changed.
- **Could break:** If a stored key cannot be decrypted (wrong `TOKEN_ENCRYPTION_KEY`), BYO checkout now fails closed (no link, no fallback to the platform key) and a BYO refund is parked as `provider_ambiguous` without contacting the provider.
