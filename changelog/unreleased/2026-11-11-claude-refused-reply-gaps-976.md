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
  - **Plain text sends:** the executor's own text sends (validation errors, cancel/restart, back, step-not-found, media hints, custom step-override prompts and the rest) also carry a refusal up.
  - **Transcript:** on a refusal, `execute()` removes the refused reply's line from `conversation_log`, together with every later bot line written in the same execution. It takes one extra session save, only on refusal; the save before sending is unchanged and a stale save writes nothing. Each bot line is written just before it is sent, and sends go in the same order, so none of the later lines reached the customer either. The refused line is found by the logged message object, or by its text among this execution's new bot lines. Lines that were already in the transcript when the execution started are never removed.
  - **Usage tracking:** outbound usage is counted only when at least one message was sent. Usage tracking and the spend-threshold check are now kept alive with `after()`, like the #974 low-balance check.
- **`lib/bot/financial-denial.ts` (new):** `isFinancialDenial` (the same three conditions as before) and `RefusedSendError`.
- **`lib/bot/bot.service.ts`:** the #682 catch uses `isFinancialDenial`, same behaviour as before. The welcome-button catch now passes a refusal on instead of treating it as a non-fatal error.
- **`lib/bot/handlers/keyword-actions.ts`:** same change for the keyword-action catch. Before this, these two catches would have swallowed the now-surfaced refusal, and the same message would have been routed a second time (reviewer finding on `4772109`).
- **`lib/channels/attempt-recording.ts`:** comment only. It documents that `pending_authorization` with no `sent_at` and disposition `pending_authorization` means "blocked before sending".
- **Tests:** `lib/__tests__/refused-reply-executor-976.test.ts` and `lib/__tests__/refused-reply-botservice-976.test.ts` (real BotService → executor → MetaCloudSender, with only the financial RPC faked). In `messaging-low-balance-executor-hook.test.ts`, the refused case now expects the refusal to be passed up.

**What it affects:** customers of a business with no messaging balance (or at its spend cap) now get the #682 notice on platform scope, which Waaiio pays for. Admin Chat History no longer shows the undelivered replies. Billing, pricing, the financial gate and the attempt rows are unchanged.

**What could break:**
- **Callers:** there are 25 production `flowExecutor.execute` call sites, all under `lib/bot` and all inside `BotService.handleMessage`. Graphify indexed only 3–4 of them, so the list came from grep and an AST scan. The two catches that swallowed errors around them now pass a refusal on. No payment, webhook or cron path calls `FlowExecutor`.
- **Sends outside `execute`:** catches that wrap plain business sends rather than `execute` (the conversational-AI layer, the default reply, action-dispatcher handlers) still treat a refusal as non-fatal, as before this change. A follow-up will look at them.
- **Session step:** the session still moves to the step the customer never saw, as before.
