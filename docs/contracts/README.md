# Capability Contract Registry

Machine-readable contracts for Waaiio's high-risk capability domains. Each contract declares state ownership, authorities, forbidden writes, session keys, and required regression tests.

## Risk Tiers

- **Tier 1** — Involves payments, state machines, or cross-capability coupling. Detailed contract required.
- **Tier 2** — Medium complexity. Index entry required; detailed contract planned.
- **Tier 3** — Simple enable/disable behavior. Index entry only.

## Files

- `capability-index.json` — All 32 capabilities with risk tier and contract status
- `{capability}.contract.json` — Detailed Tier-1 contracts

## Schema

Contracts follow `waaiio-capability-contract-v1`. See any `.contract.json` for the full schema.

## Validation

The governance CI script (`scripts/verify-engineering-governance.mjs`) validates:
- All Tier-1 capabilities have detailed contracts
- No duplicate capability IDs
- Referenced test files exist
- All capability IDs match `shared/capabilities.ts`

## Usage

Before modifying a shared file, check which contracts reference it. The contract's `requiredTestsOnChange` lists the regression tests that must pass.
