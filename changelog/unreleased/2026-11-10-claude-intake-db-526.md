## 2026-11-10 — Client intake forms: database (migration 526, #963 lane 1)

**Why:** Owner decision 2026-11-10 (#963). A business can link one of its forms to a service. It picks when the form is sent (before or after the booking is confirmed) and how often (first booking per client, or every booking). Pro and Premium only, including the trial.

**What changed**
- `supabase/migrations/526_booking_intake_forms.sql`:
  - `services.intake_form_id`, `intake_timing`, `intake_frequency`. The form must belong to the same business, and deleting the form unlinks it.
  - A plan guard trigger: setting or changing a link needs Pro, Premium or an active trial. Clearing a link, or editing other fields, is always allowed.
  - A new `booking_intakes` table (one row per intake link). RLS lets only the owner read; only the server writes. Only the sha256 of the link token is stored. It has one row per booking and form.
  - `submit_booking_intake_526(token, answers)` (service_role only). It saves one `form_responses` row with the intake's phone, and is idempotent.
- `lib/__tests__/booking-intakes-526.pg.test.ts`: real-PostgreSQL proof of the guard, integrity, RLS and grants, submit (wrong or expired token, required answers, double and concurrent submit), and the final catalog.
- `.github/workflows/ci.yml`: the pg test step requires the new test file, and the unit test run excludes it.

**Affects:** nothing yet. No app code reads or writes the new objects until lanes 2 and 3.

**Could break:**
- Saving a service with a new intake link fails for Starter businesses after the trial. This is intended, and the dashboard UI (lane 2) must hide the option for them.
- Adding unique indexes on `services (id, business_id)` and `bookings (id, business_id)` is a no-op for data, because `id` is already unique.
