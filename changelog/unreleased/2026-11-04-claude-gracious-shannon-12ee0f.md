## 2026-11-04 — Logo, staff photo and voice-note uploads work again; Seating form accepts typed numbers and explains the midnight rule (#878)

**Uploads**


- Found by the Owner on staging. The same bug is live in production. Settings → Business logo showed "Upload failed" because `POST /api/business/upload-logo` returned 500.
- **Cause:** these routes upload to the public `business-documents` bucket with the owner's own Supabase client, at a path whose first folder was a fixed word: `logos/…`, `staff-photos/…`, `chat-audio/…`. The only owner write policy, "Business owners manage own documents" (M133), requires the first folder to be one of the owner's business IDs. M135 removed the permissive upload policy, so every such upload was denied. Product and service images already use `<business_id>/products/…` and `<business_id>/services/…`, and they work.
- **Changed files:**
  - `app/api/business/upload-logo/route.ts` now uploads to `<business_id>/logos/<timestamp>.<ext>`.
  - `app/api/staff/upload-photo/route.ts` now uploads to `<business_id>/staff-photos/<timestamp>.<ext>`.
  - `app/api/chat/upload-audio/route.ts` now uploads to `<business_id>/chat-audio/<timestamp>-<name>.<ext>`.
- **Unchanged:**
  - no storage policy change;
  - the owner client and RLS tenancy, the ownership check, file checks and Sharp re-encode;
  - the public URL saved to `logo_url` / `photo_url`, and the signed URL for audio.
  - Readers use the stored full URL. The WhatsApp webhook's `chat-audio/…` writer uses the service client and was not changed.
- **Tests:** `lib/__tests__/business-upload-paths-878.pg.test.ts` (new, real PostgreSQL, run by the `.pg.test.ts` job; `.github/workflows/ci.yml` excludes it from the plain test run and requires the file).
  - It applies M033, M133, M135 and M492 from disk and checks the policy set matches production.
  - It drives the three real route handlers. Before the fix all three returned 500; after it they succeed.
  - It proves the old path shapes are denied, another tenant is denied, and the M492 verification guard still holds.
- **Could break:** logos, staff photos and voice notes uploaded from now on use the new folders. Production has no objects under `logos/` or `staff-photos/`, so no existing logo or staff photo URL changes. The public form file upload (`app/form/[token]/page.tsx`, anonymous, `form-uploads/…`) is still denied by the same policy. It needs a server route and is tracked separately in #878.

**Seating form** (`app/dashboard/seating/page.tsx`, Owner findings on staging 2026-11-04)

- **Number fields:** Max Capacity, Min Party Size, Duration and Deposit could not be cleared. Each change fell back at once to 1, 1, 90 or 0, so clearing snapped back and typing produced values like "015".
  - Each field now holds the text being typed and is checked on save, with clear messages: capacity 1–500, min party size at least 1 and not above capacity, duration 1–480 minutes (the database limits), deposit 0 or more, whole numbers only.
  - A field left empty saves the value it used to fall back to (1, 1, 90, 0).
- **Hours past midnight:** a table whose Available Until is at or before Available From (e.g. 22:00 → 02:30) showed the raw `seating_no_overnight` database error.
  - The rule stays (M476, Owner decision M510): late-night bookings come from the business opening hours.
  - The form now stops before saving and shows the Owner's wording, which points to Settings → Business → Operating Hours (the section's name in the app).
  - A `seating_no_overnight` error from the database shows the same message. Other errors are shown as before.
  - The "Uses business hours" hint is kept.
- **Tests:** `lib/__tests__/seating-form-staging-fixes.test.tsx` (new, renders the real page): 9 of 13 failed before the change, 13 of 13 pass after it.
- **Could break:** nothing else imports this page. Other dashboard forms still use the same snap-back number pattern; they are listed as follow-ups in the PR and not changed here.
