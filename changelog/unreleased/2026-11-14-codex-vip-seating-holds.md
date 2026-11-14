## 2026-11-14 — Internal seating holds for merchants

- Adds owner-authorized partial-seat and whole-resource holds to Tables & Sections, with explicit resource selection, business-local dates/times, auditable release, and retry-safe creation (Issue #1025).
- Preserves one customer reservation per resource: held seats reduce the remaining party capacity; whole holds block customer bookings. Booking pickers and the atomic booking function consult holds.
- Migration 542 introduces tenant-scoped holds and shared resource locking, checks peak simultaneous occupancy, and prevents direct capacity reductions or booking occupancy changes from conflicting with bookings and holds. Calendar and reservation status failures retain the current selection and show an error. Direct conflicting writes fail with an explicit retry instead of waiting in inverted lock order.
- Implements the Owner-approved form, help, confirmation, status, and error wording. No synthetic customer, booking payment, or revenue is created.
- Tests cover rendered create/retry/release UI, authenticated API allow/deny paths, interval boundaries, existing table-booking regressions, and disposable PostgreSQL capacity/concurrency tests.
- Could break: table availability and resource capacity edits if migration 542 is not applied before the application release. PostgreSQL 17 catalog evidence and independent exact-head reviews are required before release.
