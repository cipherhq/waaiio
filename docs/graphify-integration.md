# Graphify Integration — Engineering Intelligence Tool

> Supplements existing governance. Does not replace the Operating Order, Release Gate V2,
> pre-change checklist, or review gates.

## What Graphify Is

A local, AST-based knowledge graph of the Waaiio codebase. It maps files, functions,
imports, and call relationships. Useful for blast-radius analysis before changes.

**What it can do:**
- Find all callers of a function (`graphify affected "functionName"`)
- Trace shortest path between two nodes (`graphify path "A" "B"`)
- Answer structural questions about the codebase (`graphify query "question"`)
- Rebuild after code changes in ~30 seconds, no API cost

**What it cannot do (known limitations):**
- Cross TS↔SQL boundaries (`.rpc()` calls to SQL functions are invisible)
- Model database triggers, CHECK constraints, or RLS policies
- Distinguish runtime-only paths (environment routing, feature flags)
- Detect business-logic ordering constraints (e.g., status must be 'active' before allowance)
- Replace manual verification of DB column types, enums, or grants

## Installation

Already installed:
- CLI: `~/.local/bin/graphify` (v0.9.17)
- Claude skill: `~/.claude/skills/graphify/SKILL.md` (`/graphify` slash command)
- MCP server binary exists (`~/.local/bin/graphify-mcp`) but requires `pip install "graphifyy[mcp]"` to function

## Refreshing the Graph

```bash
cd ~/Desktop/waaiio  # or the working repo directory
~/.local/bin/graphify update . --no-cluster   # AST extraction only, ~30s, $0
~/.local/bin/graphify cluster-only . --no-label  # Add community detection, $0
```

The graph is stored in `graphify-out/graph.json`. It is **not** committed to the repo.
Each developer maintains their own local copy.

## Using the Graph

### Pre-change blast-radius check (supplements CLAUDE.md checklist step 2)

```bash
# Find all callers/dependents of a function you're about to change
graphify affected "processSuccessfulPayment" --depth 2

# Find the shortest path between two subsystems
graphify path "allocateSharedChannelWithFallback" "processSuccessfulPayment"

# Ask a structural question
graphify query "What calls recordPlatformFee?"
```

### TS→SQL RPC dependency check (supplements Release Gate V2)

The `scripts/ts-rpc-linker.py` tool closes the TS↔SQL gap that Graphify cannot detect:

```bash
# Full dependency map
python3 scripts/ts-rpc-linker.py

# Check a specific RPC
python3 scripts/ts-rpc-linker.py --check initialize_terminal_effects

# JSON output for tooling
python3 scripts/ts-rpc-linker.py --json
```

This maps 237 RPC calls from 162 TS files to 330 SQL function definitions in migrations.
It identifies Release Gate V2 high-risk RPCs and their callers.

**Important: what "matched" means and does NOT mean.** A match means the linker found
a `CREATE [OR REPLACE] FUNCTION` statement in a migration file whose name matches the
string literal in a `.rpc('name')` call. This is a **repository-level name match** only.
It does NOT prove:
- The matched migration is the currently deployed version of the function
- The function signature (parameter types, return type) matches what the TS caller sends
- The function has the expected execution behavior or side effects
- Overloaded functions (same name, different signatures) are correctly disambiguated

The linker records ALL definitions for each function name (including historical
`CREATE OR REPLACE` entries across multiple migrations). The last entry in the sorted
list is the most recent migration, but the actual deployed state depends on which
migrations have been applied. Use `RELEASE_GATE_V2.md` §2 (final-state migration checks)
to verify the cumulative deployed state.

## Graph Metadata

| Field | Value |
|-------|-------|
| Source commit | `8e7a1f9b` (origin/main, 2026-10-23) |
| Nodes | 15,662 |
| Edges | 29,414 (raw) / 33,247 (with community edges) |
| Extraction | 98% EXTRACTED, 2% INFERRED |
| Node types | code: 11,463 / document: 4,026 / rationale: 89 / concept: 84 |
| Edge types | contains: 12K, imports: 5.6K, calls: 5K, imports_from: 4.4K |
| Communities | 1,631 (unlabeled) |
| LLM cost | $0 (AST-only) |

## Edge Confidence Classification

When using `graphify path` or `graphify affected` for regression impact analysis:

- **EXTRACTED + calls/imports/imports_from**: High confidence. Direct code dependency.
- **EXTRACTED + contains**: Structural containment (file→function). Not a call dependency.
- **INFERRED**: Low confidence. May be a shared-helper connection, not a business dependency.
- **Shared-library paths** (e.g., both files import `createServiceClient`): These are
  coincidental imports, not proof of a business relationship. Classify as low-confidence.

## Known Gaps — Verified

### Dynamic imports invisible to AST

`processSuccessfulPayment` has 8 static importers that Graphify finds, but 2 production
files use `await import('@/lib/payments/process-success')` (dynamic import):
- `app/api/dashboard/pending-transfers/[id]/route.ts`
- `app/api/cron/payment-reconciliation/route.ts` (second import)

These are invisible to both Graphify and the RPC linker's file-level scan.

### Indirection layers flatten caller graphs

`processSuccessfulPayment` is never called directly by webhooks. All 5 webhook handlers
and 18 other call sites go through `reconcilePayment()` → `authorizeAndFinalize()`.
Graphify shows `reconcilePayment` as the only direct caller at depth 1. The actual
21 production call sites only appear at depth 2+. This is accurate but means
depth-1 `affected` queries undercount the true blast radius.

### Financial writes outside RPC boundary

`recordPlatformFee` (in `process-success.ts`) does a direct `.from('platform_fees').insert()`
— not an RPC call. The RPC linker cannot detect this TS→SQL write because it only tracks
`.rpc()` calls. Direct Supabase client table operations are a separate blind spot.

### Bot handleMessage RPC surface is narrow

`handleMessage` itself calls only 3 RPCs: `get_bot_context`, `update_session_cas`,
`decline_recurring_offer`. The broader RPC surface (payment RPCs, terminal effects, etc.)
is in downstream flow executors and shared helpers, correctly reachable via Graphify at
depth 2+ but not directly attributable to `handleMessage`.

## Known Gaps — Onboarding Failure Validation

Two distinct shared-channel onboarding failures informed this evaluation. They have
different trigger conditions, affected tiers, and detection characteristics.

### Failure A: Free shared-channel activation blocked by CHECK constraint

**Scenario:** A free-tier business on `wa_method='shared'` completes onboarding but has
no `assigned_channel_id` (initial allocation failed silently). The verify route's free
path (`verify/route.ts:686-694`) attempts `UPDATE businesses SET status = 'active'`.
The CHECK constraint `chk_shared_requires_channel` (`NOT (status = 'active' AND
wa_method = 'shared' AND assigned_channel_id IS NULL)`) rejects the update.

**Fix:** Self-healing path at `verify/route.ts:696-707`: detect the blocked update,
call `allocateSharedChannelWithFallback()` with `repairStaleSharedChannel: true`,
verify channel readiness, retry activation.

**What Graphify detects:** All 4 callers of `allocateSharedChannelWithFallback()`
including the self-healing path in `verify/route.ts`. The import edge is correctly
identified.

**What the RPC linker detects:** `allocate_shared_channel` (M430:167, SECURITY DEFINER,
service_role only) called from `whatsapp-readiness.ts:120`. Also `reassign_shared_channel`
in the repair path.

**What neither tool detects:** That the free activation path writes
`businesses.status = 'active'` which can be blocked by the CHECK constraint on
`assigned_channel_id`. The constraint is SQL-internal and not represented in the graph
or the RPC linker.

### Failure B: Paid shared-channel messaging allowance ordering bug (#682/#684)

**Scenario:** A paid-tier business on `wa_method='shared'` pays for a subscription. The
verify route calls `activate_paid_subscription` RPC (M418:234-249) which reads
`v_biz.status` at the start of the transaction while the business is still `'pending'`.
The channel-readiness check (`IF v_biz.wa_method = 'shared' AND v_biz.status = 'active'`)
fails, returning `allowance_granted: false` silently. The subscription and tier activate
correctly but the messaging allowance is skipped. When the messaging financial gate is
enabled, the business cannot send WhatsApp messages.

**Fix:** Post-activation allowance recovery at `verify/route.ts:627-663`: after
`activate_paid_subscription` returns and the business status transitions to `'active'`,
check `allowance_granted`. If false, call `reconcile_paid_allowance` (M375, SECURITY
DEFINER) which re-checks channel readiness against the now-active state.

**What the RPC linker detects:** `verify/route.ts:548` calls `activate_paid_subscription`,
`verify/route.ts:636` calls `reconcile_paid_allowance`. Both are SECURITY DEFINER.
The linker identifies the co-location of both RPCs in the same file.

**What neither tool detects:**
1. Stale state snapshot: RPC reads `v_biz.status` before the caller updates it
2. Silent partial success: `activated: true` with `allowance_granted: false`
3. Asymmetric behavior: only affects `wa_method='shared'`, not `wa_method='dedicated'`
4. The SQL-internal conditional (`v_biz.status = 'active'`) that gates the allowance

### Summary

For both failure classes, the combined tools identify *which files, RPCs, and migrations
are involved*. They cannot detect CHECK constraint violations (Failure A) or cross-
transaction state ordering bugs (Failure B). Manual review of the SQL function bodies
and the calling sequence remains required. The tools narrow the search space.
