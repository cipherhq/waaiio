## 2026-11-05 — Waaiio logo on the event ticket and the payment receipt

**What changed** (Owner request with the logo files, design approved from previews on 2026-11-05)

- **Receipt:**
  - the Waaiio logo is at the top;
  - "RECEIPT" and the business name follow;
  - "Powered by Waaiio · waaiio.com" is at the bottom.
- **Event ticket:** the Waaiio logo is at the bottom of the tear-off stub, with "Powered by Waaiio · waaiio.com" under it.
- **A business's own logo** (when uploaded) now sits small beside its name: on the receipt under "RECEIPT", and on the ticket before the organiser name in the purple body. It no longer takes the top or stub position.
- **White-label tiers** (none today) show no Waaiio logo or text; the business logo takes the old position.
- **Files:**
  - `lib/pdf/brand-assets.ts` (new): the Owner-supplied wordmark (identical to `public/logo.png`), embedded as a small PNG so no PDF needs a network fetch for it.
  - `lib/pdf/receipt-generator.ts`: the single receipt only. The history and annual statements are unchanged.
  - `lib/pdf/ticket-generator.ts`.
  - `lib/pdf/merchant-image.ts` (new): the logo and flyer loading from #891, moved out of the ticket generator so the receipt uses it too.

**Receipt business logo now uses the ticket's safer loader** (`loadBusinessLogo`):
- only URLs in this project's public `business-documents` bucket (where `/api/business/upload-logo` stores logos);
- redirects refused;
- 5 MB cap;
- re-encoded to a PNG of at most 256 px.

This fixes receipt Bug D from #889 (WebP logos silently missing). Logos stored anywhere else are no longer drawn on receipts. In production none are (0 of 51 businesses have a logo yet).

**Tests:**
- `lib/pdf/__tests__/receipt-brand-logo.test.ts` (new):
  - wordmark and footer text;
  - WebP business logo drawn beside the name, with `redirect: 'error'`;
  - white-label;
  - URLs outside the bucket are never fetched.
- `lib/pdf/__tests__/ticket-stub-barcode.test.ts`:
  - the wordmark is on every ticket and embedded once;
  - white-label stub;
  - image counts updated.
- Red check: against `main`'s generators, 8 of these tests fail.

**Could break:**
- Every non-white-label ticket and receipt PDF grows by about 18 KB: the 10.7 KB wordmark PNG becomes an image plus a transparency mask, embedded once per PDF.
- On the receipt, the business name is now a single line; very long names (over about 55 characters) end in "…" instead of wrapping into the status badge (reviewers 901-a and 901-b, P2).
- A receipt whose `logo_url` points outside the bucket no longer shows that logo.
- The website's browser-tab and app icons (still the green bubble) are not changed here.
