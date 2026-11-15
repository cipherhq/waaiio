## 2026-11-15 — Show current status in My Bookings (#1052)

- Show current booking and stay status in both customer My Bookings list entrypoints, including up to five cancelled bookings and five cancelled stays within the existing upcoming date windows. Separate cancelled queries preserve the existing five active bookings, five active stays and five valid tickets; earlier cancellations cannot crowd out active records.
- Split history into messages of at most ten rows without dropping records; retain the existing Back control once at the end of the handler listing.
- Keep cancelled booking details readable while removing cancellation/rescheduling controls. Recheck current status before accepting a stale reschedule action.
- Preserve customer ownership predicates, date windows, existing active allocations and confirmed-booking actions; no payment, refund, notification or database-schema change.
- Verification uses the actual merchant status PATCH, a mocked cancellation RPC updating shared local fixtures, then both actual list handlers and booking detail/stale reschedule paths. Existing ownership-denial tests remain unchanged. No hosted cancellation or provider send.
