## 2026-11-15 — Bounded Paystack initialization diagnostics (#1062)

- Paystack initialization rejection logs retain the existing safe provider summary and add an allowlisted validation-hint enum plus a valid numeric HTTP status when available. Unknown or conflicting field indications remain unknown.
- The Paystack-only helper never emits provider message text, payload values, credentials, email addresses or matched substrings. Shared redaction behavior is unchanged.
- Request bodies, payment amounts/routing, retries, persistence and returned success/failure behavior are unchanged. A hint is diagnostic evidence, not a confirmed root cause or payment fix.
- Tests exercise the actual adapter with intercepted HTTP responses, canary secrets/PII, malformed responses, ambiguous hints and unchanged success; existing BYO initialization and redaction regressions are included.
- Could break: consumers of initialization error logs see an additional bounded diagnostic object. No provider configuration or migration changes.
