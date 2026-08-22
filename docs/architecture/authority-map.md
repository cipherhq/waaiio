# Critical Authority Map

One canonical authority per critical truth domain. Where multiple writers exist, they are documented as authority debt.

## Authorities

| Truth domain | Canonical authority | File | Durable marker | Status |
|---|---|---|---|---|
| Payment provider truth | `verifyWithProvider` | `lib/payments/provider-adapters.ts` | N/A | ✅ Single authority |
| Payment lifecycle | `authorizeAndFinalize` | `lib/payments/authority.ts` | `finalization_completed_at` | ✅ Single authority |
| Customer spend (booking/reservation) | `apply_payment_spend_once` | Migration 334 | `payment_spend_applications(payment_id UNIQUE)` | ✅ Durable marker |
| Customer spend (order) | `apply_customer_spend_once` | Migration 333 | `order_spend_applications(order_id UNIQUE)` | ✅ Durable marker |
| Customer visit counters | `increment_customer_visit` | Migration 165 | None | ⚠️ No idempotency marker |
| Booking confirmation (paid) | `processSuccessfulPayment` | `lib/payments/process-success.ts` | CAS `.in('status', ['pending'])` | ⚠️ Legacy `verifyPayment` also writes (DEBT-001) |
| Booking creation | Flow step (`create_booking` / `process_payment` / `process_tickets`) | Various flow files | None | ✅ Single writer per flow |
| Order confirmation + stock | `apply_order_stock_once` | Migration 333 | `order_stock_applications(order_id UNIQUE)` | ✅ Durable marker, `FOR UPDATE` serialized |
| Ticket issuance (state) | `ensurePaidTicketState` | `lib/payments/ticket-business-state.ts` | Via `finalize_free_ticket_booking` RPC | ✅ Stage 2 |
| Ticket delivery | `sendTicketsAfterPurchase` | `lib/bot/flows/shared/send-tickets.ts` | Internal dedup | ✅ Stage 3 |
| Loyalty award | `handlePostCompletion` loyalty section | `lib/bot/flows/shared/post-completion.ts` | None | ⚠️ No per-payment marker (DEBT-002) |
| Platform fee | `recordPlatformFee` | `lib/payments/process-success.ts` | `platform_fees` UNIQUE on payment_id | ✅ Idempotent |
| Capability entitlement | `getEffectiveCapabilities` / `getEnabledCapabilities` | `lib/capabilities/policy.ts`, `service.ts` | DB `business_capabilities` | ✅ Centralized |
| Bot session transition | `FlowExecutor` via `update_session_cas` RPC | `lib/bot/flows/executor.ts` | CAS version column | ✅ Serialized |
| Notification delivery | `notifyOwner*` functions | `lib/bot/flows/shared/notify-owner.ts` | None | ⚠️ Multiple types per entity (#166) |
| Payout eligibility | `platform_fees` + `payout_mode` | `lib/payments/process-success.ts` | `platform_fees` table | ✅ Single writer |

## Known Authority Debt

See `docs/acceptance/registry.json` → `knownAuthorityDebt` for DEBT-001 and DEBT-002.
