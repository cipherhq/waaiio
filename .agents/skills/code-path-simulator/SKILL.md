# Code Path Simulator

> **MANDATORY: Run this BEFORE saying "done" on any bot or API change.** Simulates real user actions by tracing actual code execution line by line. This is the last check before deployment.

You simulate user interactions by reading the code and following every branch. You don't run the code — you READ it and trace execution as if you were a debugger stepping through each line.

## When to Run

- Before saying "done" or "ready to deploy" on ANY bot change
- Before saying "done" on any API route change
- Before saying "done" on any payment/webhook change
- Whenever a change involves multiple files that interact

## How to Simulate

### For Bot Interactions

Given an input (e.g., "user types 'cancel' at select_time step"), trace:

```
1. bot.service.ts handleMessage() called with:
   - from = "2348012345678"
   - text = "cancel"
   - session.current_step = "select_time"
   - session.business_id = "uuid-123"

2. Line XX: [check] → [result]
3. Line XX: [check] → [result]
4. Line XX: [action taken]
5. ...continues until a response is sent or function returns

FINAL: User sees "[exact message text]"
       Session state: [active/inactive, current_step = X]
```

### For API Requests

Given a request (e.g., "POST /api/waivers/sign with invalid token"), trace:

```
1. route.ts line 1: rate limit check → [pass/fail]
2. line X: token validation → [found/not found]
3. line X: [response returned]

FINAL: HTTP [status], body: [response]
```

## Test Scenarios to Always Simulate

### Bot — Navigation (3 commands)
For EACH of these, simulate at select_time, select_date, collect_name, my_bookings, and chat_handoff:

1. User types "back"
   - Does it reach executor or bot.service.ts?
   - Is it in BACK_WORDS? Is the step in FREE_TEXT_STEPS?
   - What step does the user land on?

2. User types "cancel"
   - Same trace. Does it match BACK_WORDS or CANCEL_WORDS?
   - Does bot.service.ts intercept it or does the executor handle it?

3. User types "menu"
   - Does it restart the business?
   - Is the pending booking/order cancelled?

4. User types "exit"
   - Is the session deactivated?
   - What buttons show?
   - Does tapping each button work (go_back_biz, switch_biz)?

### Bot — Quick Rebook
5. Returning church user types "Hi"
   - Is lastFlowType correct?
   - Is the action word "Give" or "Book"?
   - Does tapping the rebook button route to the right capability?
   - Does tapping "Something Else" show the menu?

### Bot — Payment Flow
6. User pays via Paystack webhook
   - Is sendProactiveConfirmation called?
   - Is the session deactivated?
   - If user taps "I've Paid" after webhook, is dedup working?

### API — Auth
7. Unauthenticated POST to a protected route
   - Is auth checked?
   - Is the error response generic (not leaking details)?

## Report Format

For each simulation:
```
SCENARIO: [description]
INPUT: [what the user sends/does]

TRACE:
  bot.service.ts:XXX → [check] → [result]
  bot.service.ts:XXX → [action]
  executor.ts:XXX → [check] → [result]
  ...

RESULT: [what user sees]
SESSION: [state after]
VERDICT: PASS / FAIL

[If FAIL]: Expected [X], got [Y] because [root cause at file:line]
```

## Rules

1. **Read the ACTUAL code** — don't guess what a function does. Open the file, read the line.
2. **Follow EVERY if/else branch** — don't skip conditions. Evaluate each one with the simulated variables.
3. **Check variable values** — don't assume session.business_id is set. Check if the test scenario would have it.
4. **Flag any line where behavior depends on timing** — webhook vs bot race conditions, concurrent messages, etc.
5. **If a path leads to a response the user wouldn't expect, that's a BUG** — even if the code "works" technically.
6. **Never say PASS unless you traced the complete path** from input to user-visible response.

## Common Traps

1. bot.service.ts catches a word BEFORE it reaches the executor → different behavior than expected
2. executor.ts has CANCEL_WORDS that overlap with bot.service.ts patterns
3. Session deactivated but buttons shown → next tap has no session → dead end
4. FREE_TEXT_STEPS list is incomplete → navigation command treated as user input
5. Step history empty → "back" at first step returns unexpected message
6. Business_id null on session → escape hatch fallback path fires → wrong response
