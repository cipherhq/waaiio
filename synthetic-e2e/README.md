# Synthetic E2E Testing Harness

> **Issue:** [#728](https://github.com/cipherhq/waaiio/issues/728) — Staging-only synthetic merchant→customer E2E harness

## What This Is

Test infrastructure for evaluating Waaiio bot behavior in isolation. No staging traffic, no production changes, no real WhatsApp sends.

**Current state:** Unit and component tests only. Actual staging E2E execution requires separate Owner/CTO authorization.

## Safety Layers

1. **CapturingMessageSender** — Implements the real `MessageSender` interface at the BotService boundary. Injected in place of `MetaCloudSender`. All outbound sends captured in-memory, zero Meta API calls.
2. **Network-level Meta egress denial** — Process-level `fetch` interceptor blocks `graph.facebook.com`. Defense-in-depth even if sender is bypassed.
3. **Environment guard (fail-closed)** — Production URLs, production Supabase ref, live payment keys, and real Meta tokens all rejected before any bot execution.
4. **Cleanup executor (fail-closed)** — CLI exits nonzero without staging DB credentials. Dry-run prints plan without deleting. No placeholder exits.
5. **Synthetic identities** — Reserved `1-555-000-xxxx` phone range, `synth-e2e-*@test.waaiio.internal` emails.

## Architecture

```
synthetic-e2e/
├── lib/
│   ├── bot-test-harness.ts       # BotService runner with mock Supabase
│   ├── capturing-sender.ts       # MessageSender impl that captures sends
│   ├── network-deny.ts           # Process-level Meta fetch blocker
│   ├── environment-guard.ts      # Fail-closed staging/credential validation
│   ├── hmac-signer.ts            # Meta webhook HMAC signing
│   ├── synthetic-identity.ts     # Deterministic test identities
│   ├── cleanup-manifest.ts       # Track synthetic data for cleanup
│   ├── cleanup-executor.ts       # Fail-closed cleanup CLI
│   ├── webhook-client.ts         # Signed webhooks (future staging use)
│   ├── capture-transport.ts      # Legacy capture utility
│   ├── db-assertions.ts          # Read-only DB verification
│   └── audit-logger.ts           # Markdown + JSONL audit trail
├── journeys/
│   ├── merchant-signup.ts        # Playwright browser journey (future)
│   └── customer-conversation.ts  # Webhook scenarios (future staging)
├── personas/                     # Promptfoo persona configs (5 personas)
├── locust/                       # Bounded load testing config
├── __tests__/                    # Test files (see counts below)
├── promptfooconfig.yaml          # Promptfoo evaluation config
├── .env.example                  # Required environment variables
└── reports/                      # Generated reports (gitignored)
```

## Running Tests

### Unit and component tests (no staging access needed)

```bash
npx vitest run synthetic-e2e/__tests__/
```

**Test inventory (139 tests, 13 files):**

| File | Tests | What it proves |
|------|-------|---------------|
| `environment-guard.test.ts` | 30 | Production URLs, Supabase refs, live keys, Meta tokens, preflight |
| `hmac-signer.test.ts` | 10 | HMAC signing matches Meta format |
| `capture-transport.test.ts` | 10 | Capture transport isolates sends |
| `synthetic-identity.test.ts` | 15 | Identities use reserved ranges, markers, extraction |
| `cleanup-manifest.test.ts` | 10 | Ordering, dedup, executeCleanup fail-closed, allowlist, verify gate |
| `audit-logger.test.ts` | 10 | Event recording, Markdown, redaction |
| `capturing-sender.test.ts` | 11 | All MessageSender methods captured at boundary |
| `network-deny.test.ts` | 7 | Meta fetch blocked, local-only, counters |
| `bot-stop-start.test.ts` | 9 | BotService STOP/safety with captures, authorization proof |
| `bot-stop-start-stateful.test.ts` | 3 | Deferred-mutation STOP→START→re-STOP, B unchanged, write failure |
| `sender-authorization-boundary.test.ts` | 5 | Real MetaCloudSender: deny→0 calls, authorize→1 call |
| `remote-simulation-safety.test.ts` | 13 | Locust/Promptfoo/WebhookClient source + runtime fail-closed |
| `locust-runtime-safety.test.ts` | 6 | Python validate_host runtime: remote rejected, loopback accepted, 302 not followed |

### Cleanup CLI (intentionally unsupported)

Staging database execution and verification are **intentionally unsupported** until separately authorized. The CLI exits nonzero for `--execute` and `--verify` regardless of credentials.

```bash
# Dry-run: prints deletion plan, no DB access needed — the only supported mode
npx tsx synthetic-e2e/lib/cleanup-executor.ts --dry-run --manifest <path>

# Execute: intentionally exits nonzero — staging deletion not authorized
npx tsx synthetic-e2e/lib/cleanup-executor.ts --execute --manifest <path>

# Verify: intentionally exits nonzero — staging verification not authorized
npx tsx synthetic-e2e/lib/cleanup-executor.ts --verify --run-id <id>
```

The exported `executeCleanup()` function is gated with a table allowlist, mandatory synthetic markers on every row, staging project identity verification, and affected-row count checks. `verifyZeroSyntheticRows()` uses run-specific patterns and propagates query errors.

## Authorization Boundary

Bot-logic tests (what the bot replies) run with `CapturingMessageSender`. Send-authorization controls (hard-stop `assertMessagingAllowed`, financial `check_or_authorize_send`) live in `MetaCloudSender.withAttemptAndGuard` and are tested by:
- `lib/__tests__/stop-timeout-bypass.test.ts` (executable BotService tests from #727)
- `lib/__tests__/stop-merchant-resolution.test.ts` (structural STOP/START proofs from #727)
- `lib/__tests__/stop-persistence-db.pg.test.ts` (DB persistence tests from #727)

## Governance

- No staging execution without explicit Owner approval
- No merge without CTO exact-SHA review + Owner authorization
- No production deployment (staging infrastructure only)
- CLI commands exit nonzero for unsupported operations
