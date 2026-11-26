## 2026-11-26 — Fix main build: duplicate `metadata` field on the reservations page

**What changed:** `Booking` in `app/dashboard/reservations/page.tsx` declared `metadata` twice: once typed for the M557 table offer (#1152) and once as `Record<string, unknown>` for pre-booking answers (#1151). Each PR built on its own, but together `next build` fails with "Duplicate identifier 'metadata'". The second, looser declaration is removed. The pre-booking answers are still read through `bookingCustomAnswers()` and `<PreBookingAnswers>`, which both take `unknown`, so nothing else changes.

**Files:** `app/dashboard/reservations/page.tsx` (one type line removed, comment updated).

**Affects:** Type checking only. The query, rendering, CSV export and table-offer display are unchanged.

**What could break:** Nothing at runtime. Code that later reads other `metadata` keys on `Booking` must go through a helper that accepts `unknown`, or widen the M557 type.
