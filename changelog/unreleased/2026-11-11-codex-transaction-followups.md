## 2026-11-11 — Sequence transaction completion prompts

- Deliver transaction confirmation and customer deliverables before save-card steps, then ask eligible customers explicitly about updates before showing business options. Covers shared paid completion and successful free capability completion.
- Implements the Owner-requested prompt order; preserves existing consent and STOP decisions. Adds service-only migration 534 and scoped card-setup cancellation.
- Tests: 383 targeted local tests across 20 files, zero failed/skipped; 26 disposable PostgreSQL checks (including inherited-default ACL regression); targeted production TypeScript check. Full PR CI evidence is tracked in the PR.
- Could break: shared completion, saved-card continuation, consent routing, and final-menu delivery; staged WhatsApp acceptance remains required.
- CI: run admin and smoke browser jobs in matching official Playwright images with preinstalled system dependencies; verify version and browser presence, preserving all test and environment guards.
