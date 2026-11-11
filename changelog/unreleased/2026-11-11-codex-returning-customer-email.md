## 2026-11-11 — Remember customer email at the same store

- Implements the Owner's repeat-customer rule in scheduling, ordering and reservation email collection, using business-and-phone-scoped customer records and prior booking/reservation email where available.
- Explicitly entered email is remembered without granting notification consent or changing saved-card, payment or transaction-follow-up routing.
- Tests cover fresh-session reuse, store/phone isolation, invalid email, lookup failures and consent-preserving persistence.
- Could break: email prompts may be skipped when a valid same-store email exists; missing or ambiguous records retain the prompt. No migration is required.
