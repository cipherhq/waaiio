## 2026-11-14 — Share campaign donation pages

- Add public campaign donation pages and dashboard copy/WhatsApp sharing of the same URL.
- Reuse campaign eligibility, limits, country-authoritative payments and both merchant custody routes. Public donations retain a distinct donor attempt across retries and verify donation linkage before provider dispatch.
- Include public campaign attempts in verify-first payment recovery when fee policy is disabled.
- Owner approved the donation form and sharing copy, including international-format phone and optional name/email.
- Tests cover public route/middleware boundaries, rendered form behavior, concurrent attempts, payment linkage and provider callback/recovery ordering.
- Could break campaign checkout initiation or recovery if attempt identity or provider correlation changes. Existing bot-only campaign reuse remains a separately tracked issue.
