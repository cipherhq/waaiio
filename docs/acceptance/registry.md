# Acceptance Finding Registry

Durable tracking of acceptance findings. Machine-readable data in `registry.json`.

## Findings

| ID | Title | Status | Resolution |
|---|---|---|---|
| ACC-001 | WhatsApp capability menu omitted enabled business actions | RESOLVED | PR #154 |
| ACC-002 | Dashboard/sidebar information architecture too dense | OPEN | |
| ACC-003 | Paid capability entitlement/billing lifecycle | OPEN | |
| ACC-004 | Production schema drift: promo_verification enum | RESOLVED | Migration 332 |
| ACC-005 | My Account empty-state / historical access UX | OPEN | |
| ACC-006 | Multi-capability greeting copy | OPEN | |
| ACC-007 | Welcome Buttons half-configured | OPEN | |
| ACC-008 | Order/payment state machine fix | RESOLVED | PR #156 |
| ACC-009 | Deferred ordering work | DEFERRED | Referenced in ACC-008 handoff |
| ACC-010 | Deferred sidebar/billing work | DEFERRED | Referenced in ACC-008 handoff |
| ACC-011 | Deferred promotions schema work | DEFERRED | Referenced in ACC-008 handoff |

## Known Authority Debt

| ID | Title | Risk | Files |
|---|---|---|---|
| DEBT-001 | Legacy verifyPayment() gateway side effects | Latent dual-write | paystack/stripe/flutterwave/square/paypal.ts |
| DEBT-002 | Non-idempotent handlePostCompletion side effects | Replay double-award | post-completion.ts |
