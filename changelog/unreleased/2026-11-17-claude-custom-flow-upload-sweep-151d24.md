## 2026-11-17 — Custom Flow: daily sweep for orphaned photo/PDF uploads (#1085)

- **Why:** Reviewer A's condition on PR #1088. A customer's photo or PDF could stay in the private `custom-flow-uploads` bucket with no answer pointing at it (the server stopped between upload and save, an overtaken photo's own delete failed, or a Storage delete failed). Neither the owner's delete nor the 12-month retention job could reach these files.
- **What changed:**
  - New `lib/custom-flow-responses/upload-sweep.ts` (`sweepOrphanedUploads`) and cron route `app/api/cron/custom-flow-upload-sweep/route.ts` (CRON_SECRET via `verifyCronAuth`, service client), scheduled daily at 02:00 UTC in `vercel.json`, after retention at 01:30.
  - A file is deleted only when all hold: it sits at the engine's exact shape `<business uuid>/<flow uuid>/<session uuid>/<file>`; no `custom_flow_answers` row of that business has that exact `file_path`; and Storage says it was created more than 24 hours ago. A missing created time, a failed or possibly cut-short answers lookup, or any other shape keeps the file.
  - Walks business by business with `list()` paging; caps per run (2,000 deletes, 5,000 list calls, 45 s) and a random starting business; the response says `complete: false` when a cap stopped it. Re-running is safe.
  - Failures go to `reportFailure()` (`area: 'cron'`, `job: 'custom-flow-upload-sweep'`, business id only); the run carries on and returns 500 with counts. Logs and the response carry counts only, never paths.
- **Unchanged:** M546, the engine upload/save path, the answers API, the retention job and the 12-month rule. No migration.
- **Tests:** `lib/__tests__/custom-flow-upload-sweep.test.ts` (15, real route handler with an in-memory Storage/answers boundary).
- **What could break:** if Storage `list()` stops returning folders with `id: null` or files without `created_at`, the sweep keeps everything (fails safe) rather than deleting. Not run against staging or production Storage in this change.
