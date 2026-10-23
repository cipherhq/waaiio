# WhatsApp Routing: Staging vs Production (Owner decision, 2026-10-24)

Status: **approved engineering requirement, not yet implemented or validated**. See #682. Do not infer that production configuration is correct merely because records exist.

## Environment behavior

| Business country | Staging shared WhatsApp delivery | Production shared WhatsApp delivery |
| --- | --- | --- |
| US | Existing staging US channel | Active configured US shared channel |
| GB | Existing staging US channel | Active configured GB shared channel |
| CA | Existing staging US channel | Active configured CA shared channel |
| NG | Existing staging US channel | Active configured NG shared channel |
| GH | Existing staging US channel | Existing explicitly authorized GH→NG fallback, only when eligible |

In **staging only**, all five supported business countries must be able to register and converse through the **one physical staging US shared WhatsApp number**, differentiated by business bot code. This is not a change of business country. Retain each merchant's own country code for currency, pricing, payment provider, fees, messaging costs, and rules.

In **production**, preserve country-correct shared routing, with no global US fallback. Only pre-approved country fallbacks (currently GH→NG) may be used. Dedicated channel onboarding remains distinct: the merchant's own Meta/WABA identity, verified ownership, connection readiness, and callbacks are required in both environments.

## Design and security invariants

- Explicit server-side environment gate; any missing, ambiguous or production environment value must fail closed, never enable the staging-only cross-country rule.
- Do not duplicate the same physical Meta phone_number_id/WABA identity into fabricated country channel rows. Reuse the single genuine staging channel record.
- Apply the staging-only policy consistently at every layer: allocation SQL/RPC, M430 database business activation constraints, application-level channel compatibility/readiness, inbound webhook recipient identity and bot-code lookup, outbound sending, and retries. One-layer fallback alone is insufficient.
- Keep channel enabled/connected checks, capacity enforcement, route ownership, bot-code uniqueness and isolation, anti-abuse checks, subscription/credit authorization and accounting. Reject unsupported countries and invalid channel identities.
- Production routing checks must not be weakened. No cross-environment credentials, tokens, WABA IDs, business/channel row copying or secret exposure.
- A previously assigned cross-country channel is **not** proof that current readiness/activation or correct country billing work.
- No changes to the approved staging **89-category** new-signup design, Free/Pro/Premium entitlements, or trial rules. Legacy merchant categories must remain operational while new signup shows only approved categories.

## Required engineering verification before changes

1. Inventory read-only staging/production channel identities, provider state, RPCs, capacity and activation constraints, and actual business routing.
2. Identify smallest safe environment-scoped implementation; justify SQL migration needs and reversible deployment sequencing.
3. Test in disposable PostgreSQL and app tests: staging US/GB/CA/NG/GH allocation to the sole US shared channel, one identity; production exact-country routing and authorized GH fallback; production rejects NG/GB/CA→US; invalid env and inactive/disconnected channel fail closed; capacity/bot-code/financial rules preserved.
4. E2E staging: create **no duplicate JaneLux**. Trace pending-business recovery through final Free activation and trial/allowance idempotency, not merely `retryBusinessId` finalization. Verify real WhatsApp inbound and outbound messages and accounting.
5. Independently verify dedicated Meta Embedded Signup and ownership; a code trace alone does not establish live connection works.

## Release gate

**Do not merge, deploy, run database migrations or repair data, mutate provider settings, or touch production without explicit Owner/CTO authorization.** Open a scoped PR with exact-head CI, regression results, staging acceptance plan, rollback plan and confirmation production guard is unchanged.

References: #682 (channel and bot recovery), #689 (category/signup consistency), M430 guard.
