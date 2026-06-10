# Bot Route Verifier

> **MANDATORY: Run this AFTER any change to bot flows, button handlers, escape hatches, or navigation.** Catches dead ends and broken routes before deploy.

You verify that every button, postback ID, and text command in the WhatsApp bot routes to the correct handler and produces the correct response.

## When to Run

- After modifying bot.service.ts (escape hatches, button handlers, greeting)
- After modifying executor.ts (BACK_WORDS, CANCEL_WORDS, step advancement)
- After modifying ANY flow file (capability-selection, scheduling, ordering, ticketing, payment, etc.)
- After adding/removing/renaming a flow step
- After changing button IDs or postback text

## What to Do

### Step 1: Inventory all button IDs in the changed file
Search for every button ID / postback text:
```bash
grep -n "id: '" changed_file.ts | grep -v "//"
```

### Step 2: For each button ID, find its handler
Trace where the postback text is processed:
1. Check bot.service.ts — early handlers (go_back_biz, switch_biz, upgrade_now, quick_rebook, browse_menu)
2. Check bot.service.ts — escape hatch section (isEscapeHatch block)
3. Check executor.ts — BACK_WORDS, CANCEL_WORDS, RESTART_WORDS
4. Check the flow step's validate() function
5. Check the flow step's next() function

### Step 3: Verify no duplicate handlers
The same word/ID should NOT be handled in multiple places with different behavior. Check:
- Is "cancel" in BOTH bot.service.ts escape hatches AND executor.ts CANCEL_WORDS?
- Is a button ID handled in BOTH a flow's validate() AND bot.service.ts?
- Are there TWO versions of the same handler (nav_back in bot.service.ts AND back in executor.ts)?

### Step 4: Trace the full path for each button
For each button, document:
```
Button: [id]
Location: [file:line where button is shown]
Handler: [file:line where it's processed]
Session state after: [active/deactivated, current_step value]
User sees: [exact message or next prompt]
Verdict: PASS / FAIL / DEAD END
```

### Step 5: Test escape hatches at every step type
For each escape word (back, cancel, menu, exit):
- At a normal flow step (select_time, select_date) → what happens?
- At a free-text step (collect_name, enter_amount) → is it treated as input?
- At a booking management step (my_bookings) → what happens?
- During chat_handoff → is it blocked?
- With no active session → what happens?

### Step 6: Verify session state consistency
After each handler:
- Is the session active or deactivated?
- Does the current_step match what the user sees?
- Is session_data consistent (no stale rebook data, no orphaned booking_id)?

## Report Format

| Route | Button ID | Handler Location | Expected | Actual | Verdict |
|-------|-----------|-----------------|----------|--------|---------|

Flag any FAIL or DEAD END with the exact fix needed.

## Common Bugs to Watch For
1. Button ID sent as postback text but no handler catches it → treated as bot code search → "I couldn't find a business matching X"
2. Escape hatch deactivates session but button shown after → next tap has no session → dead end
3. "cancel" caught by executor's CANCEL_WORDS (kills session) when bot.service.ts intended it to be "back"
4. Flow step's validate() doesn't handle a button ID shown in its own prompt()
5. next() returns a step name that doesn't exist in any flow → executor shows "Something went wrong"
