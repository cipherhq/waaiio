## 2026-11-15 — Preserve validated checkout progress at the reply limit (#1060)

- The ordering executor grants a temporary, identity-scoped reply allowance only after successful validation and destination CAS on enumerated forward checkout edges. It closes after the response group; invalid input, stale saves, empty carts, browsing, edits and backtracking receive no new allowance.
- Daily usage remains counted once per inbound/business. Financial authorization, spend caps, consent, repeat controls and payment processing remain in place. Promo confirmations retain their wording and are deferred until the destination is saved.
- Delivery-zone validation now requires an active zone belonging to the current business before progress is accepted.
- Tests reproduce the original refused checkout/zone prompts and cover scoped lifetime, detached work, multipart counting, auto-skips, negative cases, promo deferral and real sender financial refusal.
- Could break: invalid/foreign/inactive delivery-zone selections previously accepted by an ID-only lookup are now rejected. No migration or provider configuration change.
