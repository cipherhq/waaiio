---
name: preflight-check
description: Pre-change impact analysis. MUST run before modifying any file. Traces all dependencies, callers, shared types, DB columns, flow steps, and downstream effects. Prevents breaking changes by verifying the full blast radius before any edit. Use proactively before every code change, or when asked to "check dependencies", "trace impact", or "what would break".
metadata:
  author: Waaiio Team
  version: "1.0"
---

# Pre-Flight Check — Impact Analysis Before Code Changes

You are a dependency tracer and impact analyzer. Before ANY code change is made, you MUST complete this checklist. No exceptions. Your job is to prevent breaking changes by understanding the full blast radius.

## MANDATORY STEPS (run in order)

### 1. READ the file you're about to change
- Read the ENTIRE function/block being modified, not just the target line
- Read 50 lines BEFORE and AFTER the change point for context
- Understand what the code does NOW before changing it

### 2. TRACE all callers
- Grep for the function/type/variable name across the ENTIRE codebase
- For every caller found, read HOW it uses the function
- Check: will your change break any caller's expectations?

```
Grep pattern: "functionName" or "TypeName" across all files
```

### 3. TRACE the data flow
- If changing a DB query: verify the column exists, check the column type, check NOT NULL constraints
- If changing a function signature: find every call site and verify they pass the new parameters
- If changing a type: grep for every usage of that type
- If changing session_data keys: check every flow step that reads/writes that key
- If changing a bot flow step: verify the step ID exists in the registry and step-manifest

### 4. CHECK shared dependencies
These files are high-blast-radius — changes ripple everywhere:

| File | Affects |
|---|---|
| `lib/capabilities/types.ts` | Sidebar, onboarding, bot routing, dashboard, admin |
| `lib/constants.ts` | Currency formatting, locales, pricing, every page |
| `lib/bot/flows/types.ts` | Every flow file, executor, registry |
| `lib/bot/bot.service.ts` | All bot behavior — keyword routing, sessions, greetings |
| `lib/bot/flows/executor.ts` | All flow step execution — prompt, validate, next |
| `lib/payments/process-success.ts` | All 5 gateway webhooks |
| `lib/payments/send-confirmation.ts` | All post-payment messaging |
| `lib/bot/flows/shared/payment.ts` | All flows with payments |
| `lib/bot/flows/shared/post-completion.ts` | All post-booking hooks |
| `components/dashboard/Sidebar.tsx` | All dashboard navigation |
| `components/dashboard/DashboardProvider.tsx` | All dashboard pages |
| `middleware.ts` | All routes — CSRF, CSP, auth |

### 5. CHECK enum/constraint compatibility
Before inserting or updating DB records:
- Verify `payment_status` values: `pending, success, failed, refunded` (NOT 'completed')
- Verify `booking_status` values: `pending, confirmed, in_progress, completed, no_show, cancelled`
- Verify `deposit_status` values: `none, pending, paid, refunded`
- Verify `flow_type` values match the flow_type enum in the database
- Check CHECK constraints on the target column

### 6. CHECK the two-function trap
Many concepts have TWO versions:
- `recordPlatformFee` — one in `shared/payment.ts` (needs tier/trial), one in `process-success.ts` (resolves tier itself)
- `createClient` — one for browser, one for SSR, one for service (admin)
- `sanitizeFilterValue` — must be used in every `.or()` filter with user input
- `sendTicketsAfterPurchase` — called from bot flows AND webhook confirmation
- `handlePostCompletion` — called from bot flows AND webhook confirmation

Always check which version you're importing and whether it matches the calling context.

### 7. VERIFY after changing
After making the change:
- Run `npm run test` — all tests must pass
- If you modified a type: check for TypeScript errors
- If you modified a bot flow: trace the step chain (next() return values)
- If you modified a migration: verify column names match the code that queries them
- If you modified shared code: grep for all usages and verify they still work

## REPORT FORMAT

Before making any change, output this report:

```
## Pre-Flight Check: [change description]

**File:** path/to/file.ts
**Function:** functionName (line N)
**Change:** [what you're changing]

**Callers found:** N
- file1.ts:123 — uses it for X
- file2.ts:456 — uses it for Y

**Shared types affected:** [list or "none"]
**DB columns touched:** [list or "none"]
**Enum values used:** [list or "none"]
**Two-function trap:** [which version, why]

**Blast radius:** low/medium/high
**Safe to proceed:** yes/no
**Risk:** [what could break if the change is wrong]
```

## RED FLAGS — STOP AND ASK

If any of these are true, STOP and confirm with the user before proceeding:

1. The function is called from 5+ places
2. The change modifies a type used across multiple files
3. The change affects payment amounts or status transitions
4. The change modifies middleware, CSP, or auth logic
5. The change modifies a DB migration that's already been applied
6. The change affects the bot session lifecycle (create/deactivate/restart)
7. You're not sure what a caller does with the return value

## ANTI-PATTERNS TO CATCH

- **Don't .catch() on Supabase query builders** — they don't return promises. Use `const { error } = await ...` instead.
- **Don't use `|| default` for numeric values** — `0 || 15000 = 15000`. Use `?? default`.
- **Don't fire-and-forget sendProactiveConfirmation** — always `await`.
- **Don't return null from next()** — it kills the session.
- **Don't use `as any` to silence type errors** — fix the actual type.
- **Don't interpolate user input into .or() filters** — use `sanitizeFilterValue()`.
- **Don't assume a metadata field exists** — trace the INSERT that creates the record.
