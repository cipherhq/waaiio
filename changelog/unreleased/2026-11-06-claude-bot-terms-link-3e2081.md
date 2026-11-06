## 2026-11-06 — Bot terms link opens the business's terms page

- **What changed:**
  - New public page `/t/<business slug>` (`app/t/[slug]/page.tsx`). It shows the terms text the business saved in Settings → Payments → Checkout (`businesses.metadata.terms_text`).
  - When the business has no terms text, or has switched terms off, the page redirects to Waaiio's `/terms`. An unknown, malformed or inactive slug returns 404.
  - The "📎 Terms:" link in the bot's scheduling, ordering, payment, reservation and ticketing summaries now comes from one helper, `getBusinessTermsUrl` in `lib/bot/flows/shared/terms.ts`. It uses the deployment's own domain (`NEXT_PUBLIC_APP_URL`, default `https://www.waaiio.com`), so staging links open on staging.
- **Why:** the bot linked to `https://www.waaiio.com/t/<slug>`, but no `/t/` route existed, so the link returned 404 everywhere.
- **Data exposure:** anonymous visitors still cannot read `businesses`. The page reads with the service client but selects only the business name and the two metadata keys `terms_text` and `require_terms_before_payment`, for `status = 'active'` businesses only (the same rule as `businesses_public`). The text is rendered as plain text, never as HTML.
- **Files:**
  - `app/t/[slug]/page.tsx`, `app/t/[slug]/business-terms.ts` (new)
  - `lib/bot/flows/shared/terms.ts`: new `getBusinessTermsUrl`
  - `lib/bot/flows/{scheduling,ordering,payment,reservation,ticketing}.flow.ts`: the terms link line and the `shared/terms` import only
  - Tests (new): `app/t/[slug]/__tests__/business-terms-page.test.tsx`, `lib/bot/flows/__tests__/terms-link-resolves.test.ts`
  - `lib/__tests__/ordering-validated-path.test.ts`: its stand-in for `shared/terms` now also provides `getBusinessTermsUrl`. No expected outcome changed.
- **Unchanged:** when the terms link is shown (paid summaries with terms on), a merchant-set `metadata.terms_url` still wins, the in-chat terms prompt (`getTermsPrompt`), the accept/cancel buttons and how acceptance is recorded.
- **Could break:** if `NEXT_PUBLIC_APP_URL` were set to a wrong domain in an environment, the terms link would point there. Production uses `https://www.waaiio.com`.
