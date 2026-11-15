## 2026-11-15 — Discover published custom flows in the business menu

- Append entitled, published custom-flow snapshot names to the existing business menu, using its existing pagination and preserving ordinary options. Blank entry keywords work through flow-ID entry.
- Scope displayed-page selections to business/session, preserve numeric navigation, consume custom starts through the existing session CAS and recheck publication/entitlement before using the existing engine. Preserve active-flow, PIN, business-code and restart precedence.
- Ordinary numeric selections keep their displayed meaning instead of being interpreted as custom keywords. Directory selections redispatch through the existing handler with original message type and trust provenance; a separate internal accounting marker prevents duplicate inbound metering. Typed opt-in numbers cannot grant consent; genuine taps keep existing handling.
- First-time dedicated-number greetings also enter the existing menu when a valid published custom flow is eligible; explicit canonical/deep-link routes and absent, unpublished or denied flow behavior stay unchanged.
- Files: capability-selection flow, BotService, custom-flow menu/entry helpers and engine, related runtime tests, and the capability lifecycle contract. No migration, payment, API, customer-copy or hosted-state change.
- Risk: menu ordering/pagination, stale selections, tenant routing and inbound accounting. Covered by executable menu, engine, BotService and executor tests; hosted WhatsApp acceptance remains a separate gate.
