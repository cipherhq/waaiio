# Code Review

Review code changes thoroughly before committing. For every issue or recommendation, explain the concrete tradeoffs and ask for input before assuming a direction.

## Engineering preferences (match these):
- DRY is important — flag repetition aggressively
- Well-tested code is non-negotiable — identify missing tests
- Code should be "engineered enough" — not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity)
- Handle more edge cases, not fewer — thoughtfulness > speed
- Bias toward explicit over clever
- Security is paramount — this handles real money

## Review checklist (work through each):

### 1. Security review
- Auth checks on every API route (ownership verification)
- RLS policies on new tables
- Input validation and sanitization
- No secrets exposed to client (NEXT_PUBLIC_ check)
- Webhook signature verification
- SQL injection via .or() filters
- Open redirect vulnerabilities

### 2. Architecture review
- Does this change affect other features? Trace dependencies.
- Data flow: where does data come from, where does it go?
- Single points of failure?
- Is the change in the right layer (bot flow vs API route vs lib)?

### 3. Code quality review
- DRY violations — is this pattern repeated elsewhere?
- Error handling — what happens when this fails?
- Edge cases — null values, empty arrays, missing fields, race conditions
- Type safety — any `as any` casts hiding bugs?
- Are column names, enum values, and CHECK constraints verified against the DB?

### 4. Money review (if touching payments/fees/payouts)
- Amounts: correct units (naira vs kobo, dollars vs cents)?
- Platform fees recorded correctly?
- Refund handling: does it reverse fees?
- Payout calculation: is the math right?
- Idempotency: can this double-charge or double-pay?

### 5. Bot flow review (if touching bot flows)
- Step routing: does next() return a valid step ID?
- Session data: are keys consistent across steps?
- WhatsApp constraints: button titles ≤20 chars, max 3 buttons, list max 10?
- Escape hatches: can the customer cancel/exit?
- Does it notify the business owner?
- Does it show self-service tips after completion?

### 6. Performance review
- N+1 queries (querying in a loop)?
- Missing indexes for new queries?
- Large result sets without pagination?
- Unnecessary data fetching (SELECT * when only a few columns needed)?

## For each issue found:
- Describe the problem concretely with file and line references
- Present 2-3 options including "do nothing"
- For each option: specify effort, risk, impact on other code
- Give your recommended option and why
- Ask if the user agrees before proceeding

## Workflow:
- Work through one section at a time
- After each section, pause and ask for feedback before moving on
- Do not assume priorities on timeline or scope
