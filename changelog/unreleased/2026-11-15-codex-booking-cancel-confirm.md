## 2026-11-15 — Confirm cancellation from the Bookings page (#1051)

- Require an explicit confirmation from the Bookings row, detail and bulk cancellation actions. Show the booking reference, customer and date or selected count; focus the safe Keep booking action first and support safe dismissal/Escape.
- Lock duplicate submissions while pending. Retain failures for retry without repeating successful bulk cancellations; report failure without claiming success.
- Capture booking type and business before confirmation. Preserve existing booking status API, refund, waitlist and notification behavior; reservation cancellation requires a returned business-scoped row before notification.
- Scope: shared Bookings page, focused confirmation component and rendered tests. Calendar and appointment catalog actions are unchanged. No migration or hosted cancellation.
- Validation: rendered page and dialog tests cover all three entrypoints, allow/deny, dismissal, pending duplicates, partial bulk failure and zero-row reservation updates; existing cancellation regressions are run separately.
