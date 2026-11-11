## 2026-11-11 — The messaging top-up popup scrolls, ready for longer package lists

**Why:** the Owner asked on 2026-11-11 for more messaging-credit top-up options in every currency (for example ₦50,000 to ₦200,000 and $20 to $500). The packages themselves are the `messaging_topup_packages` setting, changed through the admin Platform Settings editor (up to 10 per currency), so no code is needed to add them. The top-up popup on the billing page could not scroll, though. With 7 options it is about 575px tall: on a 548px phone screen its title is cut off, and on a landscape phone (375px) "Continue to Payment" sits below the screen with no way to reach it.

**What changed**
- **`app/dashboard/billing/page.tsx`:** the top-up popup is limited to the screen height (with a 16px margin) and scrolls inside itself. It also has `role="dialog"` and an accessible name. Nothing else about the popup changed.
- **`lib/__tests__/billing-topup-package-ladder.test.tsx` (new):** renders the billing page with 7 Nigerian packages. It checks that every package is shown, that the popup scrolls, and that choosing ₦200,000 sends exactly `20000000` kobo to `/api/messaging/topup`.

**What it affects:** only the top-up popup layout on the merchant billing page.

**Unchanged:** the package list, checkout validation (only a listed amount is accepted), Paystack/Stripe checkout, the credit grant, refunds, price per message, the monthly spend cap, fees and payment custody.

**What could break:** nothing expected. On tall screens the popup looks the same as before.
