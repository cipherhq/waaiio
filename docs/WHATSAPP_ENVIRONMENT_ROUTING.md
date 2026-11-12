# WhatsApp Routing: Staging vs Production

Owner decisions: 2026-10-24 (#682), and the universal staging rule of 2026-11-10 (below).

## Owner rule (2026-11-10) — standing

> Every staging business, regardless of country, must use the existing US shared WhatsApp number +1 240 471 2139. Retain each business's country for currency, pricing, payment gateway, fees, and messaging costs. Production behavior must remain unchanged.

## Environment behavior

| Business country | Staging shared WhatsApp number | Production shared WhatsApp number |
| --- | --- | --- |
| Any country (US, GB, CA, NG, GH, KE, ZA, …) | The one designated staging US number, +1 240 471 2139 | — |
| US | (as above) | Active configured US shared channel |
| GB | (as above) | Active configured GB shared channel |
| CA | (as above) | Active configured CA shared channel |
| NG | (as above) | Active configured NG shared channel |
| GH | (as above) | Approved GH → NG fallback only, when eligible |
| Any other country | (as above) | Its own shared channel only; no fallback |

**Staging.** All staging businesses share the one physical staging number and are told apart by their bot code. The business country is not changed: currency, pricing, payment gateway, fees and messaging costs still follow `businesses.country_code`. There is no list of supported staging countries; every country is routed the same way.

**Production.** Unchanged. Exact-country shared routing, plus only the pre-approved fallbacks in `SHARED_CHANNEL_FALLBACK_COUNTRIES` (currently GH → NG). No global US fallback.

**Dedicated numbers** are unchanged in both environments: the merchant's own Meta/WABA identity, verified ownership, connection readiness and callbacks are required, and a dedicated channel only serves the business that owns it.

## How it is enforced

The single policy is `lib/channels/staging-whatsapp-routing.ts`.

- **Staging gate:** server-only `WAAIIO_ENVIRONMENT=staging` **and** the staging Vercel project + staging Supabase URL (`isStagingTestMode`). Anything missing, misspelled, client-side (`NEXT_PUBLIC_…`) or pointing at production infrastructure keeps production behavior.
- **Designated number:** pinned by its channel row id `1f3d8f48-acfb-4c4a-b788-5cc815f19173` **and** phone number `12404712139` (country US). Staging never searches channels by country, so a second US number or a country-local number added to staging can never take its place.
- **Fail closed:** if the designated row is missing, inactive, disconnected, not shared, owned by a business, or has a different id/number, staging allocation, readiness, merchant links and sending all refuse. Nothing falls back to another number.

Layers that apply the policy:

| Layer | Where | Staging behavior |
| --- | --- | --- |
| Readiness (activation, admin assistance) | `isAssignedWhatsAppChannelReady` | Shared channel is ready only if it is the designated unowned, active, connected number; any business country |
| Merchant links `/m/…` | `app/m/resolve.ts` → `buildVerifiedWhatsAppLink` | `wa.me/12404712139?text=<BOTCODE>[:action]` |
| Allocation, broad switch (`ENABLE_CHANNEL_ALLOCATION_OPERATIONS`) | `allocateSharedChannelWithFallback` | Assigns the designated number through `reassign_shared_channel` (locks rows, enforces `shared_number_capacity`). Moves an existing shared assignment only on the stale-repair path; keeps a ready own dedicated channel |
| Allocation, first-assignment switch (`ENABLE_FIRST_SHARED_ASSIGNMENT`) | `assignFirstSharedChannel` | Same eligibility as M507 (no channel at all, shared method, no owned channel); guarded single update; never replaces an assignment |
| Outbound sending and sign-up confirmations | `ChannelResolver.getSharedChannelForCountry` / `resolveByBusinessId` | Designated number only; a pointer to another shared number is ignored; no "any shared number" fallback |
| Other server paths that pick a shared number (OTP send, check-in / form / invoice / payment-success links, launch regions and delivery, merchant-notification invitations, Waaiio updates sender, `resolveByChannelIdForBusiness`) | `loadStagingDesignatedChannel` / `stagingDesignatedChannelProblem` | Designated number only, any business country; otherwise refuse (or show the business phone where a link already fell back to it) |
| Inbound | `ChannelResolver.resolveByPhoneNumberId`, bot-code routing | Unchanged: the inbound number identifies the channel; the business comes from the bot code / explicit selection, never from the shared channel row |
| Database | M527 `chk_shared_channel_has_no_owner` | A shared channel row can never have a `business_id` |

Staging allocation is still off unless one of the two server-only switches above is set on the staging Vercel project. Setting a switch is an Owner action.

## Invariant: a shared channel has no owner

A shared channel is platform transport. Businesses reach it through their own `businesses.assigned_channel_id`; the `whatsapp_channels` row itself must never carry a `business_id`. Readiness refuses a shared row that has one, and M527 makes the database reject it (`channel_type` defaults to `'shared'`, so an owned row inserted without a type would otherwise become an owned shared row).

## Design and security invariants (unchanged from 2026-10-24)

- Do not duplicate the same physical Meta phone_number_id/WABA identity into fabricated country channel rows. Reuse the single genuine staging channel record.
- Keep channel enabled/connected checks, capacity enforcement, route ownership, bot-code uniqueness and isolation, anti-abuse checks, subscription/credit authorization and accounting.
- Production routing checks must not be weakened. No cross-environment credentials, tokens, WABA IDs, business/channel row copying or secret exposure.
- A previously assigned cross-country channel is **not** proof that current readiness/activation or correct country billing work.
- No changes to the approved staging **89-category** new-signup design, Free/Pro/Premium entitlements, or trial rules.

## Incident record (2026-11-10)

- **Symptom:** TestBiz's merchant links on staging showed "WhatsApp Unavailable".
- **Cause found:** the designated staging shared channel had a non-null `business_id` (the "Waaiio test" business). Readiness correctly refuses an owned shared channel.
- **How it got there:** not provable from history. The channel row was created on 2026-09-25 16:18:12 UTC, 29 seconds after the "Waaiio test" business (16:17:43 UTC). No repository code path creates or edits a shared channel's `business_id` (since the channel candidate system of 2026-09-20, app code creates channel rows only through `promote_channel_candidate`, always as `dedicated`). The table has no audit trigger, `updated_at` is not maintained, and no audit row references the channel, so the most likely cause is that the row was made by hand together with that business. Issue #522 (2026-10-03) already showed the number acting as "Waaiio test"'s default business.
- **Repair:** with explicit Owner authorization, Codex cleared `business_id` on that one staging row; both TestBiz links then returned HTTP 302 to `wa.me/12404712139?text=TESTBIZ` and `…?text=TESTBIZ%3Aqueue`.
- **Prevention:** M527 (database constraint), and the single staging policy above.
- **Inventory after the repair (read-only, staging):** all 14 shared staging businesses (GB 2, NG 8, US 4) point at the designated number; 1 US business uses its own dedicated number. No reassignment was needed.

## Release gate

**Do not merge, deploy, run database migrations or repair data, mutate provider settings, or touch production without explicit Owner/CTO authorization.** M527 refuses to apply, and changes nothing, if any shared channel still has a `business_id`; check that read-only before the Owner approves applying it to each environment.

References: #682 (channel and bot recovery), #522 (shared-channel tenant authority), #266 (shared-number isolation), M430, M507, M527.
