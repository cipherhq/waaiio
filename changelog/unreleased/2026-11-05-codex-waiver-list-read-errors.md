## 2026-11-05 — Signed waiver list read errors

- `app/dashboard/waivers/page.tsx`: Show a persistent error and Retry when the signed-list request fails, instead of a false empty list or stale results. Keep the current search/template scope on retry and ignore older request completions.
- `app/dashboard/waivers/__tests__/signed-list-read-errors.test.tsx`: rendered regressions cover HTTP 401/500, transport failure, valid empty results, filtered failure/retry, stale success/failure ordering and malformed payloads.
- **Affects / could break**: Signed-list loading, error and retry presentation. Template/count reads, signing, signature storage, routes and authorization are unchanged.
