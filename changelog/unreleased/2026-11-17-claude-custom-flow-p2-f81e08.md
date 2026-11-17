## 2026-11-17 — Custom Flow Phase 2: "Use what you already have" steps (#1086)

- **What changed.** The four orange palette steps (Event tickets, Giving, Take a payment, Talk to a person) now work instead of showing "Soon". Each one adds a new terminal `handoff` node, `{ id, type: 'handoff', capability: 'ticketing' | 'giving' | 'payment' | 'chat', record_id? }` (`lib/bot/custom-flow/types.ts`). It passes the customer to the existing capability flow, which runs unchanged from its first step.
- **Runtime** (`lib/bot/custom-flow/engine.ts` `renderHandoff`, new `lib/bot/custom-flow/handoff.ts`):
  - The engine re-checks the capability with the canonical `requireCurrentCapability(..., 'create_new')`.
  - It then re-checks the record by `id` and `business_id`, using `checkHandoffRecord`: the event must be published, not past and not sold out; the service must be active, not deleted, and the right giving or non-giving kind.
  - If a check fails, the customer gets a plain-English "not available" message (`handoff-copy.ts`). They go back to the flow's first step when it waits for a reply; otherwise the flow closes.
  - If the checks pass, BotService (`bot.service.ts`, custom-flow branch) calls `startCapabilityHandoff`, which reuses the quick-rebook re-entry pattern:
    1. It keeps only `repeatSessionData`, sets `active_capability`, the capability's first step, `_step_history` and a freshly resolved effective `capabilities`, plus `_repeat_selection_id` for giving/payment.
    2. It writes the existing bot session with `update_session_cas`. If there is no bot session (keyword start on a dedicated number), it inserts one with the same stale/inactive cleanup and `_inbound_channel_id` as the new-session path.
    3. It closes the custom session.
    4. It calls `flowExecutor.execute(from, recordId ?? '')`. The record id therefore goes through the flow's own first-step validator, which reloads it under `business_id`.
- **Builder:**
  - New `HandoffSettings.tsx`: "Which feature", a record picker ("Which event / giving option / payment option", or "Let people choose"), "?" tips with examples, and an "On WhatsApp" line.
  - `StepPalette`: a working "Use what you already have" group. Only "Ask a question" stays Soon.
  - `FlowMap`: an orange-bordered card with a "Continues in …" pill.
  - `WhatsAppPreview`: handoff preview notes.
  - `friendly-errors`: three new rules.
  - `block-label`: feature names.
- **API:**
  - `/api/custom-flows/sources` gains `kind=event|giving|payment`, read with the merchant's RLS client and scoped by `business_id`.
  - `/api/custom-flows` validate/publish/preview return 422 `unavailable_handoff_record` when a step's record is not this business's, or is no longer available.
  - Preview shows a builder note instead of running the real flow.
- `readiness.ts` and `templates.ts` treat a handoff as an end node (TypeScript blast radius).
- **Unchanged:** every existing flow file (`ticketing.flow.ts`, `payment.flow.ts`, `chat.flow.ts`, `capability-selection.flow.ts`, `executor.ts`), payments, custody, fees, routing, webhooks, "I've Paid", confirmations, the stored format of message/menu/lookup nodes, and the custom-flow routing precedence. No migration.
- **Tests:**
  - New `lib/bot/custom-flow/__tests__/handoff.test.ts` (29): validator; each capability's handoff; cross-business, past, sold-out, draft, deleted, inactive and wrong-kind records; disabled capability; failed start; first-step loop guard; and the runner (existing/new session, CAS loss, effective caps, foreign session/channel, close failure).
  - New `components/custom-flows/HandoffBuilder.test.tsx` (7).
  - `app/api/custom-flows/route.test.ts` (+6): foreign record rejected on validate/publish/preview, own record publishes, preview note, feature-off preview.
  - `lib/custom-flow-builder/handlers.test.ts` (+4): picker scoping.
  - `lib/__tests__/custom-flow-botservice-routing.test.ts` (+4): real BotService + real executor. Event tickets reaches the `select_ticket_type` step with the event loaded, and chat sends the existing start message.
  - `PageBuilder.test.tsx`: the Soon test now covers only the "Ask a question" steps.
- **Could break:**
  - A customer who starts by keyword with no bot session now gets a bot session created at handoff. It has no `biz_resolution`, so it is treated as untrusted for first-message promo.
  - A handoff whose bot-session write loses a race shows the "not available" message, and the customer stays in the custom flow.
  - Event "upcoming" uses the UTC day, the same as ticketing.
