## 2026-11-16 — Staging test businesses seed (Issue #1080)

- **Why:**
  - Owner decision 2026-11-16 (#1079): add clearly-labelled test businesses on staging so every capability can be tested.
- **What changed:**
  - `scripts/staging/seed-test-businesses.sql`: new, staging-only, idempotent seed that creates six `TEST –` businesses (NG restaurant, NG salon, NG church, US events, GB gym, US home services) with fixed ids, following the same writes as sign-up (`provision-business.ts`) and free-plan verify (`onboarding/verify`), plus a few products, services, staff, events, ticket types, campaigns and a draft poll. Waaiio-owned (shared) payment route only; no keys, `example.com` emails, fictional phones. Aborts unless the staging-only shared WhatsApp channel exists.
  - `scripts/staging/remove-test-businesses.sql`: new removal script. Default retires them (suspended + hidden); optional hard delete refuses if any payment, order, booking, invoice, payout, fee or messaging record exists.
- **Affects:** staging data only, once applied by hand. No application code, migration or production change.
- **What could break:** nothing in the app. On staging, the six businesses share the designated shared number with the other staging merchants, and appear in the directory and the owner's business switcher.
