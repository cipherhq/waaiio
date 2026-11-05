## 2026-11-05 — Dependency security upgrades: Sentry 11, Next.js 15.5.29, posthog-js, dompurify, undici

- **What changed (Owner decisions 2026-11-05: "Yes, two PRs", "B: Sentry 11"):**
  - `@sentry/nextjs` ^10.49.0 → ^11.10.0. `next.config.mjs` imports `withSentryConfig` from `@sentry/nextjs/config` (moved in v11).
  - All three `Sentry.init` calls (`sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`) set `dataCollection` to Sentry's documented v10-equivalent block. v11 otherwise collects more by default (user info, cookies, IP-related headers); this keeps collection as it was.
  - `next` 15.5.27 → 15.5.29, still pinned exactly.
  - `posthog-js` ^1.370.1 → ^1.445.2; override `dompurify` 3.4.16 → 3.4.17.
  - New override `undici` 7.30.1 for the copy used by `jsdom` (test tooling). No new direct dependency.
- **Why:** `npm audit` on main flagged these packages; after this change they are clear, except one moderate advisory reported through Sentry's build-time bundler plugin (transitive `glob`), which has no v11 fix.
- **Files:** `package.json`, `package-lock.json`, `next.config.mjs`, `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`.
- **Affects:** every app build and error reporting (server, edge, browser); analytics client.
- **Could break:** Sentry 11 behaviour changes kept as defaults: span streaming, a stack trace on `captureMessage` and non-Error `captureException` (may create new issue groups), and `browserSessionIntegration` page lifecycle. The `environment` is set explicitly, so the v11 Vercel default change does not apply. Verify after deploy that a test error from `/api/admin/sentry-test` reaches Sentry.
