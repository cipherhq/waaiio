# Change-Impact Map

Critical dependency chains in the Waaiio modular monolith. Before modifying a shared file, trace its forward blast radius and backward dependencies.

## Primary Chain

```
Capability definition (shared/capabilities.ts)
  → Capability policy (lib/capabilities/policy.ts, service.ts)
    → Bot flow routing (lib/bot/flows/registry.ts, executor.ts)
      → Flow steps (lib/bot/flows/*.flow.ts)
        → Shared helpers (lib/bot/flows/shared/*.ts)
          → Payment Authority (lib/payments/authority.ts)
            → Process-success / Stage 2 (lib/payments/process-success.ts)
              → Send-confirmation / Stage 3 (lib/payments/send-confirmation.ts)
                → Post-completion (lib/bot/flows/shared/post-completion.ts)
                  → Loyalty / Notifications / Automation / Receipts
```

## High-Risk Shared Files

| File | Forward blast radius | Backward dependencies |
|---|---|---|
| `shared/capabilities.ts` | ALL capability checks, sidebar, onboarding, dashboard, bot menu | None (canonical source) |
| `lib/bot/flows/executor.ts` | ALL bot conversations | Flow registry, session CAS RPC |
| `lib/payments/authority.ts` | ALL payment lifecycle completion | `reconcilePayment` (sole caller) |
| `lib/payments/process-success.ts` | Booking/order/ticket/reservation confirmation, spend markers, platform fees | `authorizeAndFinalize` Stage 2 |
| `lib/payments/send-confirmation.ts` | WhatsApp confirmation, post-completion, tickets, owner notification | `authorizeAndFinalize` Stage 3 |
| `lib/bot/flows/shared/post-completion.ts` | Loyalty, receipts, automation, referral, customer profile | ALL payment-capable flows + Stage 3 |
| `lib/payments/bot-recovery.ts` | ALL bot "I've Paid" + "Get New Link" paths | scheduling, ticketing, payment flow validate() |
| `lib/payments/reconcile.ts` | ALL payment completion (webhooks, bot, cron) | 11 callers (see authority map) |

## Dynamic / Hidden Dependencies

These relationships are NOT visible from static imports:

| Source | Hidden dependency | Mechanism |
|---|---|---|
| Flow steps | `@/lib/payments/bot-recovery` | `await import(...)` |
| Flow steps | `@/lib/bot/flows/shared/capability-guard` | `await import(...)` |
| `processSuccessfulPayment` | `@/lib/bot/automation/rules-engine` | `await import(...)` |
| `sendProactiveConfirmation` | `@/lib/channels/channel-resolver` | `await import(...)` |
| All flows | DB RPCs (`apply_payment_spend_once`, `update_session_cas`, etc.) | `supabase.rpc()` calls |
| Cron jobs | Flow-specific business logic | Dynamic import in route handlers |
| Webhooks | Provider-specific verification | `verifyWithProvider` dispatch |
