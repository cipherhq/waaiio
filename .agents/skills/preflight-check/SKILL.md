# Pre-Flight Check

> **MANDATORY: Run this BEFORE making any code change.** No exceptions.

You are a dependency analyzer. Your job is to understand the blast radius of a proposed change BEFORE it's made. You prevent bugs caused by changing code without understanding what depends on it.

## When to Run

- Before modifying ANY function, type, table column, or flow step
- Before adding a new capability, API route, or database table
- Before changing escape hatch patterns, session handling, or payment logic

## What to Do

### Step 1: Identify the target
What file(s) and function(s) are about to be changed?

### Step 2: Find ALL callers
```bash
grep -rn "functionName" lib/ app/ components/ admin/ --include="*.ts" --include="*.tsx"
```
List every file and line that calls, imports, or references the target.

### Step 3: Trace the lifecycle
For the function being changed:
- **Who calls it?** (direct callers)
- **What calls THOSE?** (callers of callers — 2 levels deep)
- **What happens with the return value?** (does null kill a session? does false skip a step?)
- **What side effects does it have?** (DB writes, messages sent, sessions created/destroyed)

### Step 4: Check for duplicate implementations
Search for functions with the same name or similar logic in different files:
```bash
grep -rn "similar_pattern" lib/bot/ --include="*.ts"
```
Flag any dual-handler risks (bot.service.ts vs executor.ts handling the same word).

### Step 5: Check database dependencies
If changing a DB query or column:
- What migrations created/altered this column?
- What RLS policies apply?
- What indexes exist?
- What other queries read this column?

### Step 6: Report
Output a table:

| Change | Affected Files | Risk Level | Notes |
|--------|---------------|------------|-------|

Flag anything HIGH risk and recommend whether to proceed or ask the user first.

## Red Flags (STOP and ask)
- Changing a function used by 5+ files
- Modifying escape hatch patterns or CANCEL_WORDS/BACK_WORDS
- Changing session deactivation logic
- Modifying payment webhook handlers
- Altering platform_fees recording or payout calculations
- Changing the executor's step lifecycle (validate → next → advanceToStep)

## Key Dependency Chains to Check
- `CapabilityId` → types.ts, sidebar, onboarding, capability-selection, dashboard provider, admin
- `bot_sessions.session_data` → shared across ALL flow steps
- `ESCAPE_HATCH_PATTERNS` → bot.service.ts line 36 — affects every conversation
- `BACK_WORDS` / `CANCEL_WORDS` → executor.ts — affects every flow step
- `recordPlatformFee` → TWO versions exist (shared/payment.ts vs process-success.ts)
- `sendProactiveConfirmation` → webhook confirmation + session deactivation
- Payment flows → webhook handlers → platform_fees → financials → payouts
