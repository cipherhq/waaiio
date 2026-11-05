## 2026-11-05 — Escape the property name in the check-in QR print view; sanitize the phone in the invoice session filter

- **What changed:**
  1. `app/dashboard/properties/[id]/page.tsx`: the "Print QR" window now HTML-escapes the property name (title and heading), the QR image URL and the check-in URL before writing them. A property name is shown as text.
  2. `lib/payments/send-confirmation.ts`: the invoice/campaign session-deactivation `.or()` filter now passes the stored customer phone through `sanitizeFilterValue()`, like the other phone filters in the same file. Both the manifest and legacy paths.
- **Tests:** `lib/__tests__/property-checkin-qr-print-escape.test.tsx` (renders the page and checks the printed HTML), `lib/__tests__/payment-session-deactivation-filter.test.ts` (runs `sendProactiveConfirmation` for an invoice payment and checks the deactivation filter). Both fail on the previous code.
- **Affects:** the property check-in QR print window; invoice/campaign payment confirmation's waiting-session close.
- **Could break:** nothing expected. Normal phones contain no `,`, `(` or `)`, so the filter is unchanged for them (tested). Payment custody, fees, routes and confirmation order are unchanged.
