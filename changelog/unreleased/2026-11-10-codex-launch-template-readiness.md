## 2026-11-10 — Validate launch templates before confirmation and delivery

- Changed `lib/launch/delivery.ts`, added `lib/launch/template-readiness.ts`, and updated `app/api/admin/launch-notify/route.ts` to require the configured template name, language, and approved status on each selected sender before confirmation and delivery. Provider and sender lookup errors fail closed; claimed lookup failures complete as failed.
- Preview and delivery share a bounded, deterministic candidate query, including same-campaign failed recipients when retrying. Existing admin authorization, consent, confirmation scope, and claim fencing remain enforced.
- Added provider-readiness, retry-count, claim-error, and HTTP-handler tests. Focused local suite: 108 passed, zero skipped. Provider calls are mocked; no live messages sent.
- Affects launch notifications only. Meta catalog outages now block preview/send, and additional catalog reads can increase batch latency. No migration, deployment, template creation, production setting change, or notification is included.
