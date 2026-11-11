## 2026-11-10 — "Any available" staff books a staff member instead of "time just booked"

**Why:** TestBiz staging, 10 Nov 2026 ("Lashes Refil": `requires_staff`, two eligible staff). A customer chose "Any available". The bot sent no staff member; `book_slot_atomic` refuses a booking with no staff member for a service that requires staff and answers exactly like a full slot, so the customer was told "Sorry, this time slot just got booked" for a free time. This was a known "could break" item of the #919 entry. Evidence (staging DB, Vercel logs, Graphify at c26cb3f) was independently verified before this change.

**What changed** (`lib/bot/flows/scheduling.flow.ts`, shared by scheduling and appointment bookings)
- `select_staff.validate`: "Any available" (tapped, or typed "any" / "anyone") now stores `staff_id: null`, `staff_name: null` and `_staff_any: true`, so a staff member kept from an earlier pass (e.g. before "Change date") is dropped. A named pick stores `_staff_any: false`. `select_staff.skipIf` clears `_staff_any` on every new pass.
- `create_booking` (standard `book_slot_authoritative_604` and package `book_with_package_authoritative_604` calls): when `_staff_any` is set and the service requires staff, the time is offered to each staff member shown on the staff step, least busy that day first (same rule as the staff step's own assignment), one booking-function call each, until one is accepted. Only a plain refusal (`slot_available: false` / `slot_full`) moves on; any error stops at once. A booking this session already made is tried first with its own staff member, so a retry after a lost answer repeats the same request. When every staff member refuses, `staff_id` / `staff_name` are cleared and the existing "time just booked" message and time list are shown, now truthfully.
- `lib/bot/flows/shared/capability-transition.ts`: `_staff_any` is cleared on a capability switch.

**Unchanged:** the database authority (`book_slot_atomic`, `check_staff_availability`, `private.scheduling_604_create_booking`): staff schedule, per-staff capacity and buffer, the slot lock and the confirmation claim run on every try. No migration. Named staff (one call, as before), services that do not require staff ("Any available" still books without a staff member), auto-assignment, tables, classes, reschedule, payments and prices.

**Tests:** `lib/__tests__/any-staff-booking.test.ts` (real `select_staff` and `create_booking` steps): named staff, named staff refused, any staff (least busy first), first staff member unavailable then the next booked, every staff member refused after availability changed, never a call without staff, error stops the loop, retry after a lost answer, service without required staff, package booking. 11 of 14 fail on the previous code; the 3 that pass are the unchanged-behaviour checks.

**Could break:**
- "Any available" on a service that requires staff can now make up to one booking-function call per listed staff member (two for TestBiz).
- Which times the time list shows for "Any available" is unchanged: it still counts every booking on the day, not per staff member, so a time can be hidden although one staff member is free.
