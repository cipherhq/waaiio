# Phase 2 Staging Execution — Threat Model & Fail-Closed Architecture

## Scope

5 test businesses × 100 synthetic customers = 500 persisted staging journeys.
No production mutations, live provider traffic, real recipients, or untagged data.

## Threat Surface

### T1: Real WhatsApp delivery via deployed staging

**Risk:** Staging Vercel has Meta credentials configured. Signed webhooks to `/api/webhook/meta-cloud` trigger real `BotService` which uses `MetaCloudSender` → `MetaCloudService` → `graph.facebook.com`.

**Mitigation layers:**
1. **Phase 1 WebhookClient** throws `FAIL-CLOSED` before any remote `fetch()` (merged #729)
2. **Network-deny** blocks `graph.facebook.com` at process level in test harness
3. **Phase 2 requirement:** Before any staging webhook traffic, implement server-side outbound capture at the `MetaCloudService` boundary OR verify staging uses a non-deliverable test phone number
4. **Abort:** If any outbound Meta API call is detected, halt immediately

### T2: Real payment charges via staging sandbox

**Risk:** Staging may have live Stripe/Paystack keys instead of test-mode keys.

**Mitigation:**
1. **Pre-execution preflight:** Verify Stripe key starts with `sk_test_` and Paystack with `sk_test_` by checking variable name patterns in Vercel config (no secrets decrypted)
2. **Sandbox-only transactions:** All payment flows use test card numbers (Stripe `4242424242424242`, Paystack test cards)
3. **Provider-authoritative verification:** Retrieve transaction from sandbox API to confirm test-mode before recording as "paid"
4. **Abort:** If any live-mode key prefix is detected, fail closed

### T3: Email/SMS/notification delivery to real recipients

**Risk:** Staging may have real Resend/notification credentials that send to actual email addresses.

**Mitigation:**
1. Synthetic customer emails use `@test.waaiio.internal` (non-routable domain)
2. Synthetic phone numbers use reserved `1-555-000-xxxx` range
3. Pre-execution check: verify no real email addresses in synthetic identity set
4. **Abort:** If any real-looking email/phone is generated, fail closed

### T4: Cross-tenant data leakage

**Risk:** Synthetic test data could be visible to or affect real staging businesses.

**Mitigation:**
1. Run-scoped synthetic business IDs tracked in cleanup manifest
2. All synthetic records tagged with identifiable markers (`SynthBiz`, `synth-e2e-*`)
3. RLS enforces business_id scoping — synthetic businesses isolated from real ones
4. Post-run verification: zero synthetic rows match real business IDs

### T5: Unrecoverable staging data pollution

**Risk:** Test data left behind after runs, corrupting future staging tests.

**Mitigation:**
1. Cleanup manifest tracks every created entity and descendant
2. Dry-run preview before any deletion
3. Post-cleanup zero-owned-row verification
4. Owner dashboard review before any cleanup execution
5. `executeCleanup(dryRun=false)` currently throws — requires separate authorization

### T6: Deployment SHA mismatch

**Risk:** Staging deployment changes between preflight and execution.

**Mitigation:**
1. Lock exact deployment SHA in run config
2. Verify SHA via `/api/release-identity` before each batch
3. Abort if SHA changes mid-run

## Fail-Closed Gates (sequential, all must pass)

```
G1: Staging URL + Supabase ref verified ──────────────────┐
G2: Deployment SHA matches expected ──────────────────────┤
G3: Payment keys are test-mode (no sk_live_/pk_live_) ────┤
G4: Meta outbound capture proven OR webhooks disabled ────┤
G5: Synthetic identities validated (digits only, unique) ──┤
G6: No real email/phone in identity set ──────────────────┤
G7: Cleanup manifest initialized ─────────────────────────┤
                                                           ▼
                                              BEGIN EXECUTION
```

Any gate failure → entire run aborted, zero records created.

## Dependencies (BLOCKED until separately authorized)

| Dependency | Status | Required For |
|---|---|---|
| M470 `create_ticket_booking_checked` | **MISSING** on staging | Ticketing flows |
| M471 `cancel_pending_*_for_navigation` | **MISSING** on staging | Navigation cancel |
| M472 `book_table_atomic` + `seating_resources` | **MISSING** on staging | Table seating |
| Server-side Meta outbound capture | **NOT IMPLEMENTED** | Remote webhook tests |
| `executeCleanup(dryRun=false)` | **THROWS** by design | Post-run cleanup |
| Staging payment mode verification | **NOT YET PROVED** | Payment flows |
