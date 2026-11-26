## 2026-11-26 — Email question in the WhatsApp bot is optional everywhere

**What changed:** Owner decision 2026-11-26. The three bot steps that ask a customer for an email now ask "📧 Want a copy by email? Type your email or tap *Skip*." and show a **Skip** button (id `skip_email`, title from `booking.skip`). The three steps are ordering, booking (scheduling) and reservation `collect_email`. A Skip tap, or a typed "skip", saves no email and moves on to the next step:
- ordering goes to `review_order_summary`. Before this change, ordering required a valid email and had no way to skip;
- scheduling goes to `create_booking`;
- reservation goes to `create_reservation`.

A valid email is still saved to the business's customer profile, as before. A returning customer's saved email for the same business is still reused without asking (`reuseStoreCustomerEmail`).

**Copy:** `booking.collect_email`, `ordering.collect_email`, `booking.invalid_email` and `ordering.invalid_email` are rewritten in en, pcm, yo, ig, ha, tw, fr and es. Each language names its own Skip button title. Reservation used hard-coded English; it now uses the same `booking.*` copy.

**Files:**
- `lib/bot/flows/ordering.flow.ts`, `scheduling.flow.ts`, `reservation.flow.ts` (`collect_email` prompt and validate);
- `lib/bot/flows/flow-localization.ts` (copy);
- `lib/bot/__tests__/bot-latency-batch1.golden.json` (recorded booking prompt);
- tests: new `lib/__tests__/email-optional-skip.test.ts`, plus case 1D in `lib/__tests__/phase-2d-stage3-runtime.test.ts`.

**Affects:**
- Customer email is optional for every bot checkout, and payments do not need it. The ordering checkout never passes the email to a provider. Paystack and Stripe use the internal phone alias, Flutterwave uses its phone-based fallback, and Square omits `buyer_email`.
- Every downstream customer-email send already checks for an address:
  - the direct-transfer order email (`customer_order_email`, via `findCustomerEmail`);
  - the booking confirmation email (`guest_email`);
  - `sendOrEmail`;
  - the order summary line.
- Owner notifications go to the owner's email, not the customer's.
- No money routing, fee or custody change.

**What could break:**
- A customer who skips gets no confirmation email, only WhatsApp, as intended.
- A customer who types a translated word for "skip" instead of tapping the button gets the "not a valid email" reply with the Skip button again.
