## 2026-11-10 — Staging: every business uses the one US WhatsApp number (migration 527)

**Why:** Owner rule 2026-11-10: every staging business, whatever its country, uses the existing US shared number +1 240 471 2139; the business keeps its country for currency, pricing, gateway, fees and messaging costs; production is unchanged. Incident: TestBiz's staging merchant links showed "WhatsApp Unavailable" because the staging shared channel row carried a `business_id`. The row was repaired separately (Owner-authorized). How the value got there is not provable from history; no code path in the repository writes it, and the row was most likely made by hand on 2026-09-25 with the "Waaiio test" business.

**What changed**
- `lib/channels/staging-whatsapp-routing.ts` (new): the single staging policy. Gate = server-only `WAAIIO_ENVIRONMENT=staging` plus staging Vercel/Supabase identity. Designated channel pinned by row id and phone number; fails closed if missing, inactive, disconnected, not shared, business-owned or mismatched.
- `lib/onboarding/whatsapp-readiness.ts`: removed the finite staging fallback list (NG/GB/CA/GH → US). `SHARED_CHANNEL_FALLBACK_COUNTRIES` is production-only (GH → NG). Staging readiness accepts only the designated number, for any business country. Both allocation paths (`allocateSharedChannelWithFallback`, `assignFirstSharedChannel`) assign only the designated number in staging and never search by country.
- `lib/channels/channel-resolver.ts`: in staging, shared lookups return only the designated number; a business pointer to another shared number is ignored; no "any shared number" fallback.
- `app/m/resolve.ts`: passes the channel id and number to the readiness check.
- `supabase/migrations/527_shared_channel_has_no_owner.sql`: CHECK constraint `chk_shared_channel_has_no_owner` (a shared channel can never have a `business_id`). Refuses to apply, changing nothing, if any shared row still has one.
- Tests: `lib/onboarding/__tests__/staging-shared-us-routing.test.ts` (rewritten for the new rule), `lib/channels/__tests__/staging-designated-channel-resolver.test.ts`, `lib/__tests__/staging-merchant-links.test.ts`, `lib/__tests__/flow-onboarding-staging-confirmation.test.ts`, `lib/__tests__/shared-channel-has-no-owner-527.pg.test.ts`; CI wiring in `.github/workflows/ci.yml`; `supabase/catalog-deltas/527_shared_channel_has_no_owner.json`.
- `docs/WHATSAPP_ENVIRONMENT_ROUTING.md`: universal staging rule, enforcement map, invariant and incident record.

**Affects:** staging only at runtime (allocation, readiness, `/m/` links, sign-up confirmations, outbound shared sending). Production code paths are unchanged. M527 affects both databases once applied.

**Could break:**
- In staging, a business assigned to any shared number other than the designated one is now "not ready" and cannot send until moved (read-only inventory on 2026-11-10: none).
- If the designated staging row is ever replaced, `STAGING_SHARED_WHATSAPP_CHANNEL` must be updated in the same change.
- M527 fails on any database that still has an owned shared channel; check read-only before applying.
- Staging allocation still needs one of the server-only switches (`ENABLE_CHANNEL_ALLOCATION_OPERATIONS` or `ENABLE_FIRST_SHARED_ASSIGNMENT`); neither is set on the staging project today.
