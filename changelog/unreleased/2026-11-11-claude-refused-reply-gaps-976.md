## 2026-11-11 — A bot reply refused for lack of messaging balance now tells the customer, and is no longer logged as sent (#976)

**Why:** on TestBiz staging (2026-11-10/11) replies refused with `insufficient_allowance_balance` left the customer in silence. They also showed as sent in the saved transcript, and were still counted as outbound usage. The billing itself was correct.

**The Owner decided on 2026-11-11 (#976):**
- send the existing #682 notice (text unchanged, at most once per customer per 5 minutes);
- remove refused replies from `conversation_log`;
- refused `message_send_attempts` rows stay `pending_authorization`, which is now documented;
- merchant spend-cap warnings are a separate follow-up PR.

**What changed**
- **`lib/bot/flows/executor.ts`:**
  - **Refusal:** `sendMessages` stops the batch at a financial refusal and passes it up as `RefusedSendError`. The message is unchanged, so the #682 branch in `BotService.handleMessage` sends its notice. Other send errors (Meta 4xx/5xx and the rest) are still logged and the next message is still sent.
  - **Transcript:** `execute()` removes the refused replies' entries from `conversation_log` with one extra session save, only on refusal. The save before sending is unchanged. A stale save writes nothing. Entries are matched by the object that was logged, so a resent prompt that was never logged cannot remove an older delivered line. Custom step-override prompts are covered too.
  - **Usage tracking:** outbound usage is counted only when at least one message was sent. Usage tracking and the spend-threshold check are now kept alive with `after()`, like the #974 low-balance check.
- **`lib/bot/financial-denial.ts` (new):** `isFinancialDenial` (the same three conditions as before) and `RefusedSendError`.
- **`lib/bot/bot.service.ts`:** the #682 catch uses `isFinancialDenial`. Same behaviour.
- **`lib/channels/attempt-recording.ts`:** comment only. It documents that `pending_authorization` with no `sent_at` and disposition `pending_authorization` means "blocked before sending".
- **Tests:** `lib/__tests__/refused-reply-executor-976.test.ts` and `lib/__tests__/refused-reply-botservice-976.test.ts` (real BotService → executor → MetaCloudSender, with only the financial RPC faked). In `messaging-low-balance-executor-hook.test.ts`, the refused case now expects the refusal to be passed up.

**What it affects:** customers of a business with no messaging balance (or at its spend cap) now get the #682 notice on platform scope, which Waaiio pays for. Admin Chat History no longer shows the undelivered replies. Billing, pricing, the financial gate and the attempt rows are unchanged.

**What could break:** a caller of `FlowExecutor.execute` outside `BotService.handleMessage` would now receive the refusal as a thrown error. Graphify shows none: the three production callers all run inside `handleMessage`'s try. The session still moves to the step the customer never saw, as before.
