# Synthetic E2E Testing Harness

> **Issue:** [#728](https://github.com/cipherhq/waaiio/issues/728) — Staging-only synthetic merchant→customer E2E harness

Automated end-to-end testing that simulates complete merchant signup, customer WhatsApp interactions, test-mode payments, and database verification against **staging only**.

## Safety First

All code enforces fail-closed staging isolation:

- **Production URLs rejected** — `waaiio.com`, `app.waaiio.com`, production Supabase ref
- **Live payment keys rejected** — `sk_live_*`, `pk_live_*` prefixes abort immediately
- **No real WhatsApp sends** — Capture transport intercepts all outbound Meta API calls
- **No real Meta API traffic** — `graph.facebook.com` requests are blocked and counted
- **Synthetic data tagged** — Every created entity has a run_id for targeted cleanup
- **Reserved phone numbers** — Uses `1-555-000-xxxx` (ITU-T fictional test range)

Run `npx vitest run synthetic-e2e/__tests__/environment-guard.test.ts` to verify safety gates.

## Architecture

```
synthetic-e2e/
├── lib/                          # Core infrastructure
│   ├── environment-guard.ts      # Staging-only URL/credential validation
│   ├── hmac-signer.ts            # Meta webhook HMAC signing
│   ├── capture-transport.ts      # Intercept outbound WhatsApp sends
│   ├── synthetic-identity.ts     # Deterministic test identities
│   ├── cleanup-manifest.ts       # Track & clean synthetic data
│   ├── webhook-client.ts         # Send signed webhooks to staging
│   ├── db-assertions.ts          # Read-only DB verification
│   └── audit-logger.ts           # Markdown + JSONL audit trail
├── journeys/                     # End-to-end journey definitions
│   ├── merchant-signup.ts        # Playwright browser merchant signup
│   └── customer-conversation.ts  # Webhook-based customer journeys
├── personas/                     # Promptfoo persona configs
│   ├── booking-customer.yaml     # Appointment booking flow
│   ├── ordering-customer.yaml    # Product ordering with variations
│   ├── payment-customer.yaml     # Paystack test-mode checkout
│   ├── confused-customer.yaml    # Off-topic/gibberish handling
│   └── stop-start-customer.yaml  # Cancel and restart flows
├── locust/                       # Load testing
│   └── locustfile.py             # Bounded staging load profiles
├── __tests__/                    # Safety and unit tests (81 tests)
│   ├── environment-guard.test.ts # Production rejection proofs
│   ├── hmac-signer.test.ts       # HMAC signing correctness
│   ├── capture-transport.test.ts # Transport isolation proofs
│   ├── synthetic-identity.test.ts# Identity generation proofs
│   ├── cleanup-manifest.test.ts  # Cleanup ordering proofs
│   └── audit-logger.test.ts      # Logging and redaction proofs
├── reports/                      # Generated reports (gitignored)
├── promptfooconfig.yaml          # Promptfoo evaluation config
└── .env.example                  # Required environment variables
```

## Quick Start

### 1. Run safety tests (no staging access needed)

```bash
# Verify all safety gates pass
npx vitest run synthetic-e2e/__tests__/

# Expected: 6 files, 81 tests, 0 failures
```

### 2. Dry-run cleanup preview

```bash
# Preview what a cleanup run would delete (no actual deletions)
npx tsx synthetic-e2e/lib/cleanup-manifest.ts --dry-run
```

### 3. Staging smoke run (requires authorization)

> **STOP:** Do not run against staging without explicit Owner approval.

```bash
# Set staging credentials
export SYNTH_STAGING_URL=https://staging.waaiio.com
export SYNTH_META_APP_SECRET=<staging-meta-app-secret>
export SYNTH_PHONE_NUMBER_ID=<staging-phone-number-id>
export SYNTH_SUPABASE_REF=tqjvrzopvtczxfxiwmnz

# Run merchant signup journey (Playwright)
npx playwright test synthetic-e2e/journeys/ --config=e2e/playwright.staging.config.ts

# Run customer conversation scenarios (webhook-based)
npx tsx synthetic-e2e/journeys/customer-conversation.ts
```

### 4. Promptfoo persona evaluations

```bash
# Install promptfoo if not present
npm install -g promptfoo

# Run evaluations
npx promptfoo eval --config synthetic-e2e/promptfooconfig.yaml

# View results
npx promptfoo view
```

### 5. Locust load testing

```bash
# Install locust
pip install locust

# Run bounded load test (5 users, 1/sec ramp, 60s duration)
locust -f synthetic-e2e/locust/locustfile.py \
  --host https://staging.waaiio.com \
  --users 5 --spawn-rate 1 --run-time 60s \
  --headless --csv=synthetic-e2e/reports/locust
```

### 6. Inspect audit logs

After a run, reports appear in `synthetic-e2e/reports/<run_id>/`:

- `summary.md` — Master Markdown summary with pass/fail table
- `summary.json` — Machine-readable summary
- `journey-<id>.md` — Per-journey chronological log
- `events.jsonl` — Full event trace (sortable, correlatable)

### 7. Cleanup verification

```bash
# After a run, verify zero synthetic rows remain
# (Actual cleanup requires staging Supabase access)
npx tsx synthetic-e2e/lib/cleanup-manifest.ts --verify --run-id <run_id>
```

## Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `SYNTH_STAGING_URL` | Staging base URL | `https://staging.waaiio.com` |
| `SYNTH_META_APP_SECRET` | Staging META_APP_SECRET for HMAC | `<staging secret>` |
| `SYNTH_PHONE_NUMBER_ID` | Staging phone number ID | `<phone number ID>` |
| `SYNTH_SUPABASE_REF` | Staging Supabase project ref | `tqjvrzopvtczxfxiwmnz` |
| `E2E_STAGING_URL` | Playwright staging URL | `https://staging.waaiio.com` |
| `E2E_STAGING_EMAIL` | Merchant login email | `<staging test email>` |
| `E2E_STAGING_PASSWORD` | Merchant login password | `<staging test password>` |

## Safety Gates

| # | Gate | Mechanism | Test File |
|---|------|-----------|-----------|
| 1 | Environment isolation | URL allowlist + Supabase ref check | `environment-guard.test.ts` |
| 2 | No real money | Live key prefix detection | `environment-guard.test.ts` |
| 3 | No real WhatsApp send | Capture transport + Meta URL block | `capture-transport.test.ts` |
| 4 | Fixture isolation | Run-scoped manifest + targeted cleanup | `cleanup-manifest.test.ts` |
| 5 | No committed secrets | .env.example with placeholders only | Manual review |
| 6 | No production behavior change | Separate files, no app code changes | File audit |
| 7 | No unapproved execution | Manual staging-run approval required | Governance |

## Governance

- No staging execution without explicit Owner approval
- No merge without Codex security review + ChatGPT CTO review
- No production deployment (this is staging infrastructure only)
- Product behavior questions return `PRODUCT DECISION NEEDED`
