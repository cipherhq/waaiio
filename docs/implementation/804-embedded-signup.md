# Embedded Signup — issue #804

Owner authorized Codex to implement this feature on October 31, 2026. No deployment or production change is included.

Base: `ca15aae94b2abe4610691540f0687b9cf45ac8fa` (combined staging branch). Feature branch: `codex/804-embedded-signup`.

## Merchant behavior

Business registration and plan activation finish first. The existing success screen links to `/dashboard/whatsapp/connect`. That screen retains shared-number and direct phone/OTP choices and offers Meta Embedded Signup for a merchant-owned account/number.

The merchant completes Meta's flow, then explicitly chooses the account and number shared with Waaiio. There is no first-account/last-number fallback. Empty accounts, cancellation, failed registration, and expired connection sessions have recovery messages. Success appears only after the server reports an active channel.

Connecting an account does not transfer it into Waaiio's central account, attach a credit line, or change Meta billing responsibility. Coexistence remains separately gated. This feature does not resolve or assume a cause for the direct-provisioning #200 error.

## Implementation and preflight

| Change | Affected path | Risk and containment |
|---|---|---|
| Code exchange and discovery | Dashboard → Facebook discovery route | Authenticated owner check before code exchange; application identity checked; credentials remain server-side |
| Connection session | Discovery → Redis → callback | AES-GCM encryption, user/business/app binding, ten-minute expiry, atomic single-use consumption; unavailable storage fails closed |
| Explicit account/phone selection | Dashboard and selection component | No automatic number activation; cancellation performs no activation |
| Final activation | Callback → existing candidate lifecycle | Revalidates current account membership; retains conflict check, candidate fence, registration, subscription and atomic promotion |
| Registration entry point | Wizard → existing dashboard link | Removed unused alternate FB registration handler and duplicate SDK loader; existing plan/registration handlers unchanged |

No migration, RLS change, payment change, bot-routing change, provider asset grant, or billing mutation is required. Existing channel candidate schema and promotion RPC are reused.

Both API routes must ship with their updated dashboard caller. An old open browser tab that submits a raw token is intentionally rejected; reload the page and reconnect with Meta.

## Configuration and release prerequisites

Existing environment variables required:

- `NEXT_PUBLIC_META_APP_ID` and `NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID`, belonging to the same environment's Meta app.
- `META_APP_SECRET`.
- `TOKEN_ENCRYPTION_KEY`: 64 hexadecimal characters.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; storage must support GETDEL.
- Existing WhatsApp app webhook configuration and candidate activation infrastructure.

No tokens or secret values are included in this document. Session data expires automatically. A provider failure after consuming a session requires restarting Meta authorization; the existing connection-status endpoint remains authoritative if a response is lost after activation.

## Local validation

Focused command:

```sh
./node_modules/.bin/vitest run lib/__tests__/embedded-signup-*.test.* lib/__tests__/channel-candidate-routes.test.ts lib/__tests__/business-app-transfer-nonregression-592.test.ts lib/__tests__/business-app-coexistence-592.test.ts lib/__tests__/onboarding-free-defaults-component.test.ts --reporter=dot
```

120 passed, 0 skipped, across 10 files. Includes rendered dashboard/selection tests, actual discovery and callback handlers with mocked dependencies, session encryption/binding/replay/expiry tests, pagination tests, direct OTP, coexistence guards, activation ordering and onboarding regression tests. Existing test fixtures were updated to the new connection-handle contract without removing their activation/failure assertions.

Full TypeScript checks (`tsc --noEmit --incremental false`) report 519 diagnostics on both the feature tree and unchanged base `ca15aae94b2abe4610691540f0687b9cf45ac8fa`. Comparing diagnostics by file, code and message (normalizing shifted line numbers and absolute worktree paths) found zero additions and zero removals. The full repository typecheck remains failing; this is not a clean-typecheck claim.

These are local tests, not proof of live Meta acceptance, real Redis availability, database migration correctness, or a CI run. No migration was added.

## Staging acceptance still required

1. Confirm environment-specific app/config IDs, approved permissions, webhook subscription destination, and session storage availability.
2. From a newly registered merchant account, open the dashboard connection screen, complete Meta signup and enter the verification code privately.
3. Select the intended account/number and verify an active channel with matching provider identifiers in connection status.
4. Send an inbound WhatsApp message and verify a reply from that same dedicated number, scoped to the correct merchant.
5. Repeat with multiple visible numbers, cancellation, and a rejected connection. Confirm the previous/shared channel remains usable on failure.
6. Verify shared-number and direct OTP paths still work independently. Do not change production to complete staging acceptance.
