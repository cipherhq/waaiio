## 2026-11-11 — Short WhatsApp links in the public directory (#984)

- Owner request: directory WhatsApp buttons use the existing `/m/BOT_CODE` format, with the existing UUID fallback for missing or noncanonical codes. This updates the directory-only exception recorded on 2026-11-03.
- `app/(marketing)/directory/DirectoryClient.tsx` now calls `buildShortMerchantLink`; the helper, API, channel readiness checks, routing and QR links are unchanged.
- Updated directory surface and API-to-UI tests cover short links, fallback and unavailable assignments. Staging merchant-link tests also check that short codes and UUIDs reach the same designated US number across countries.
- Owner-authorized CI-only publication: `vercel.json` and `admin/vercel.json` disable Git deployments only for `codex/directory-short-links`; the deployment-control test checks both exact exceptions. Other branches retain their existing deployment controls.
- Could break: a changed canonical bot code would invalidate its short URL, so existing bot-code locking remains required. This branch cannot create Git preview deployments while its exception is present. No schema changes or deployments.
