## 2026-11-20 — Bookings cancellation test no longer fails on its fixture date

**What changed:** `app/dashboard/reservations/__tests__/cancellation.test.tsx` used a fixed booking date of 2026-11-20. On that day the Bookings page correctly lists the booking twice, once in "Today's Schedule" and once in the table, so `getByText('Guest one')` found two elements and all 5 tests failed on every branch, main included. The fixture dates are now 30 and 31 days after the current date. Test-only change: no app code.

**Files:** `app/dashboard/reservations/__tests__/cancellation.test.tsx`.

**Affects:** CI "Main App (lint, test, build)" on 2026-11-20. It unblocks #1144.

**What could break:** Nothing in the app. The test now depends on the system clock, but it can never land on today.
