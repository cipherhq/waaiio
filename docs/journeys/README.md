# Golden Journey Registry

Machine-readable registry of end-to-end behavioral invariants across Waaiio's critical paths.

## Status Values

- **PROTECTED** — Has executable test(s) that prove the journey's authority chain and terminal state
- **KNOWN_GAP** — Confirmed behavioral gap. Links to a tracking GitHub issue. Must not disappear.

## Files

- `journey-registry.json` — Machine-readable journey definitions
- This README — Human-readable overview

## Journey Structure

Each journey maps: `ID → capabilities/contracts → authority chain → expected terminal state → side effects → test paths → status`

## Usage

Before modifying a shared authority (Payment Authority, processSuccessfulPayment, handlePostCompletion, etc.), check which journeys depend on it. All PROTECTED journeys must remain green.

## Adding Journeys

When a KNOWN_GAP issue is resolved, update its status to PROTECTED and add the test path(s). The governance CI validates that PROTECTED journeys reference existing test files.
