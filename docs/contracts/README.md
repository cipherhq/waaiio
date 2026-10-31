# Capability Contract Registry

Machine-readable contracts for Waaiio's high-risk capability domains. Each contract declares state ownership, authorities, forbidden writes, session keys, and required regression tests.

## Risk Tiers

- **Tier 1** — Involves payments, state machines, or cross-capability coupling. Detailed contract required.
- **Tier 2** — Medium complexity. Index entry required; detailed contract planned.
- **Tier 3** — Simple enable/disable behavior. Index entry only.

## Files

- `capability-index.json` — All 32 capabilities with risk tier and contract status
- `{capability}.contract.json` — Detailed Tier-1 contracts
- `shared-payment-lifecycle.md` — Universal payment-to-fulfillment lifecycle standard (#721)
- `whatsapp-experience-contract.md` — Shared WhatsApp customer experience standards (#721)
- `721-capability-journey-matrix.md` — Complete 32-capability × WhatsApp journey matrix (#721)
- `721-behavior-vs-contract-report.md` — Current behavior vs contract audit report (#721)

## Schema

Contracts follow `waaiio-capability-contract-v1`. See any `.contract.json` for the full schema.

## Validation

The governance CI script (`scripts/verify-engineering-governance.mjs`) validates:
- Eight explicitly enumerated capabilities have detailed contracts with valid JSON and matching IDs: scheduling, payment, giving, ordering, ticketing, reservation, loyalty and recurring
- No duplicate capability IDs in the index
- Index total matches array length
- Index IDs match canonical `shared/capabilities.ts` CapabilityId values
- `requiredTestsOnChange` paths in those eight detailed contracts reference existing test files

The script does not dynamically enforce a detailed contract for every Tier-1 index entry, execute the referenced tests, or certify all32 capabilities. `table_reservation` remains Tier1 with a separate detailed-contract/integration gate; a green validator does not clear it. Canonical CI has12 jobs; specific test execution requires exact-SHA, job/step, count and zero-skip evidence.

## Usage

Before modifying a shared file, check which contracts reference it. The contract's `requiredTestsOnChange` lists the regression tests that must pass.
