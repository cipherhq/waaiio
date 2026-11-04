## 2026-11-04 — Business logo, staff photo and dashboard voice-note uploads work again (#878)

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
