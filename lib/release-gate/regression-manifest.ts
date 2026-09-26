/**
 * Release Gate V2 — Regression Manifest
 *
 * Machine-readable mapping from code domains to their permanent regression
 * test suites. Used by the blast-radius evaluator to determine which tests
 * must pass when specific code areas change.
 *
 * Each domain defines:
 * - pathPatterns: glob-like patterns for source files in this domain
 * - testSuites: the existing test files that guard this domain
 * - invariants: Release Gate V2 invariant IDs relevant to this domain
 *
 * @see RELEASE_GATE_V2.md §1 (Invariant Registry)
 * @see #406 (B2 — Regression Manifest)
 */

export interface DomainEntry {
  /** Unique domain ID */
  id: string;
  /** Human-readable label */
  label: string;
  /** Source file path patterns (prefix match against changed file paths) */
  pathPatterns: string[];
  /** Existing test file paths that guard this domain */
  testSuites: string[];
  /** Related Release Gate V2 invariant IDs */
  invariants: string[];
}

/**
 * The regression manifest. Each entry maps a launch-critical domain
 * to the source paths and test suites that protect it.
 *
 * Path patterns use prefix matching: a changed file matches if it
 * starts with any of the domain's pathPatterns.
 */
export const REGRESSION_MANIFEST: DomainEntry[] = [
  {
    id: 'payments',
    label: 'Payments / Payment Finalization',
    pathPatterns: [
      'lib/payments/',
      'app/api/pay/',
      'app/api/webhook/stripe/',
      'app/api/webhook/paystack/',
      'app/api/webhook/flutterwave/',
      'app/api/cron/payment-reconciliation/',
      'app/api/cron/subscription-renewal-recovery/',
      'lib/bot/flows/shared/payment',
    ],
    testSuites: [
      'lib/payments/__tests__/process-success.test.ts',
      'lib/payments/__tests__/payment-idempotency.test.ts',
      'lib/payments/__tests__/webhook-handler.test.ts',
      'lib/payments/__tests__/webhook-amount.test.ts',
      'lib/payments/__tests__/authority.test.ts',
      'lib/payments/__tests__/reconcile.test.ts',
      'lib/payments/__tests__/provider-adapters.test.ts',
      'lib/payments/__tests__/deposit-amount-authority.test.ts',
      'lib/payments/__tests__/process-success-finalization.test.ts',
      'lib/payments/__tests__/confirmation-delivery.test.ts',
      'lib/payments/__tests__/confirmation-delivery-db.test.ts',
      'lib/__tests__/payment-idempotency-db.test.ts',
      'lib/__tests__/payment-authority-db.test.ts',
      'lib/__tests__/p0-payment-confirmation-db.test.ts',
      'lib/__tests__/p0-payment-confirmation.test.ts',
      'lib/__tests__/financial-authorization-db.test.ts',
      'lib/__tests__/fee-policy-db.test.ts',
      'lib/__tests__/fee-policy-runtime.test.ts',
      'lib/__tests__/fin-001-containment.test.ts',
      'lib/__tests__/fin-002-atomic-payout.test.ts',
      'lib/__tests__/payment-routing-authority.test.ts',
      'lib/__tests__/payment-source-classification.test.ts',
      'lib/__tests__/payment-country-resolution.test.ts',
      'lib/bot/flows/__tests__/payment.flow.test.ts',
      'lib/bot/flows/__tests__/payment-webhook.test.ts',
      'lib/bot/flows/shared/__tests__/payment.test.ts',
      'lib/bot/flows/shared/__tests__/bank-transfer.test.ts',
    ],
    invariants: ['PAY-001', 'PAY-002', 'PAY-003', 'PAY-004', 'PAY-005', 'PAY-006', 'PAY-007'],
  },
  {
    id: 'saved-cards',
    label: 'Saved Cards / PIN / Reuse',
    pathPatterns: [
      'lib/payments/saved-card',
      'lib/payments/stripe-saved',
      'lib/bot/handlers/saved-card',
      'lib/bot/flows/shared/saved-card',
    ],
    testSuites: [
      'lib/payments/__tests__/saved-card-phase1-integration.test.ts',
      'lib/payments/__tests__/saved-card-db-concurrency.test.ts',
      'lib/payments/__tests__/saved-payment-adapter.test.ts',
      'lib/payments/__tests__/stripe-saved-card.test.ts',
      'lib/payments/__tests__/stripe-saved-card-checkout.test.ts',
      'lib/__tests__/saved-card-pin-ux-regression.test.ts',
      'lib/__tests__/saved-card-rpc-concurrency-db.test.ts',
      'lib/__tests__/saved-card-session-db.test.ts',
      'lib/__tests__/saved-card-cold-cache.test.ts',
      'lib/__tests__/saved-card-dispatched-recovery.test.ts',
      'lib/__tests__/saved-card-phone-normalization.test.ts',
      'lib/__tests__/p0-saved-card-offer-behavioral.test.ts',
      'lib/__tests__/stripe-saved-card-pi-params.test.ts',
      'lib/__tests__/stripe-saved-card-adapter-behavior.test.ts',
      'lib/bot/__tests__/saved-card-botservice-routing.test.ts',
      'lib/bot/__tests__/saved-card-citadel-integration.test.ts',
      'lib/bot/__tests__/saved-card-command-routing.test.ts',
      'lib/bot/flows/__tests__/saved-card-attempt-reference.test.ts',
      'lib/bot/flows/shared/__tests__/saved-card-channel-hard-stop.test.ts',
      'lib/bot/handlers/__tests__/saved-card-locator-regressions.test.ts',
      'lib/bot/handlers/__tests__/saved-card-replacement.test.ts',
    ],
    invariants: ['DB-004', 'DB-005', 'PAY-001', 'PAY-002', 'PAY-003'],
  },
  {
    id: 'appointments',
    label: 'Appointments / Booking / Rebook',
    pathPatterns: [
      'lib/bot/flows/scheduling',
      'app/api/bookings/',
      'lib/bot/flows/shared/booking',
    ],
    testSuites: [
      'lib/bot/flows/__tests__/scheduling.flow.test.ts',
      'lib/__tests__/atomic-reschedule-db.test.ts',
      'lib/__tests__/p1-appointment-closure.test.ts',
      'lib/__tests__/p1-staff-booking-authority.test.ts',
      'lib/__tests__/mk3-manual-booking-atomicity.test.ts',
      'lib/__tests__/bk1-public-booking-business-status.test.ts',
      'lib/__tests__/conflict-1-public-slot-authority.test.ts',
      'lib/__tests__/conflict-1-slot-authority-db.test.ts',
      'lib/__tests__/scheduling-payment-regression.test.ts',
      'lib/__tests__/acc-244-booking-confirmation-intent-db.test.ts',
      'lib/__tests__/p1-class-session-booking.test.ts',
      'app/api/bookings/__tests__/durable-confirmation-behavioral.test.ts',
      'lib/bot/handlers/__tests__/my-bookings-auth.test.ts',
    ],
    invariants: [],
  },
  {
    id: 'reservations',
    label: 'Reservations / Expiry / Cancellation',
    pathPatterns: [
      'lib/bot/flows/reservation',
      'app/api/reservations/',
      'lib/properties/',
    ],
    testSuites: [
      'lib/bot/flows/__tests__/reservation.flow.test.ts',
      'lib/__tests__/reservation-cancel-notification.test.ts',
      'lib/__tests__/sender-expiry-race-integration.test.ts',
      'lib/__tests__/cross-flow-convergence.test.ts',
      'lib/__tests__/cross-flow-convergence-db.test.ts',
      'lib/properties/__tests__/occupancy.test.ts',
    ],
    invariants: [],
  },
  {
    id: 'whatsapp-session',
    label: 'WhatsApp Session + Confirmation Delivery',
    pathPatterns: [
      'lib/bot/bot.service',
      'lib/bot/flows/executor',
      'lib/bot/flows/registry',
      'lib/channels/',
      'lib/bot/session',
      'app/api/webhook/meta-cloud/',
    ],
    testSuites: [
      'lib/bot/__tests__/bot-conversations.test.ts',
      'lib/bot/__tests__/bot-conversations-verbose.test.ts',
      'lib/bot/__tests__/conversation-orchestrator.test.ts',
      'lib/bot/__tests__/conversation-safety.test.ts',
      'lib/bot/__tests__/session-concurrency.test.ts',
      'lib/bot/__tests__/session-resilience.test.ts',
      'lib/__tests__/session-resilience-db.test.ts',
      'lib/__tests__/s1-botservice-real-handleMessage.test.ts',
      'lib/__tests__/s1-botservice-shared-channel.test.ts',
      'lib/__tests__/issue-219-channel-preservation.test.ts',
      'lib/channels/__tests__/channel-authority.test.ts',
      'lib/__tests__/channel-candidate-system.test.ts',
      'lib/payments/__tests__/confirmation-delivery.test.ts',
      'lib/payments/__tests__/confirmation-delivery-db.test.ts',
      'lib/bot/flows/shared/__tests__/ticket-delivery-lifecycle.test.ts',
    ],
    invariants: ['CH-001', 'CH-002', 'CH-003', 'DB-005'],
  },
  {
    id: 'stripe-paystack',
    label: 'Stripe / Paystack Routing',
    pathPatterns: [
      'lib/payments/stripe',
      'lib/payments/paystack',
      'app/api/webhook/stripe/',
      'app/api/webhook/paystack/',
    ],
    testSuites: [
      'lib/payments/__tests__/provider-adapters.test.ts',
      'lib/payments/__tests__/provider-verification-safety.test.ts',
      'lib/payments/__tests__/provider-preflight.test.ts',
      'lib/payments/__tests__/stripe-line-extractor.test.ts',
      'lib/payments/__tests__/stripe-checkout-session-url.test.ts',
      'lib/payments/__tests__/stripe-saved-card.test.ts',
      'lib/__tests__/stripe-webhook-route-177.test.ts',
      'lib/__tests__/stripe-invoice-extractors.test.ts',
      'lib/__tests__/stripe-recurring-finalization-db.test.ts',
      'lib/__tests__/paystack-charge-outcomes.test.ts',
      'lib/__tests__/paystack-reconciliation.test.ts',
      'lib/__tests__/paystack-split-recurring.test.ts',
      'lib/__tests__/payment-country-resolution.test.ts',
    ],
    invariants: ['PAY-004', 'PAY-005', 'PAY-006', 'PAY-007'],
  },
  {
    id: 'orders',
    label: 'Orders / Stock / Variable Products',
    pathPatterns: [
      'lib/bot/flows/ordering',
      'app/api/orders/',
      'app/api/catalog/',
      'lib/bot/catalog',
    ],
    testSuites: [
      'lib/bot/flows/__tests__/ordering.flow.test.ts',
      'lib/bot/flows/__tests__/acc-008-order-checkout-bypass.test.ts',
      'lib/bot/__tests__/catalog-order.test.ts',
      'lib/__tests__/s1-catalog-order-binding.test.ts',
      'lib/__tests__/order-stock-authority.test.ts',
      'lib/__tests__/ordering-validated-path.test.ts',
      'lib/__tests__/product-variant-availability.test.ts',
      'lib/__tests__/acc-247-editable-tracking-db.test.ts',
      'lib/__tests__/migration-392-inventory-reservation-db.test.ts',
      'lib/__tests__/migration-393-inventory-wiring-db.test.ts',
      'app/api/orders/[id]/tracking/__tests__/dispatch-boundary.test.ts',
      'app/api/orders/[id]/tracking/__tests__/tracking-edit.test.ts',
      'app/api/catalog/__tests__/catalog-safety-behavioral.test.ts',
      'lib/channels/__tests__/catalog-safety.test.ts',
    ],
    invariants: [],
  },
  {
    id: 'tickets-events',
    label: 'Tickets / Events',
    pathPatterns: [
      'lib/bot/flows/ticketing',
      'app/api/tickets/',
      'app/api/events/',
      'lib/bot/flows/shared/ticket',
    ],
    testSuites: [
      'lib/bot/flows/__tests__/ticketing.flow.test.ts',
      'lib/__tests__/ticket-row-identity-db.test.ts',
      'lib/__tests__/ticket-purchase-security-db.test.ts',
      'lib/__tests__/urgent-payment-ticket-hotfix.test.ts',
      'lib/bot/flows/shared/__tests__/ticket-delivery-lifecycle.test.ts',
      'lib/bot/flows/shared/__tests__/ticket-email-without-whatsapp.test.ts',
      'app/api/tickets/image/__tests__/ticket-image-route.test.ts',
      'lib/pdf/__tests__/ticket-receipt-redesign.test.ts',
      'lib/__tests__/attendance-checkin-routes.test.ts',
      'lib/__tests__/attendance-public-checkin-business-status.test.ts',
    ],
    invariants: [],
  },
  {
    id: 'invoice-giving',
    label: 'Invoice / Giving',
    pathPatterns: [
      'lib/bot/flows/invoice',
      'lib/bot/flows/crowdfunding',
      'app/api/invoices/',
      'app/api/giving/',
    ],
    testSuites: [
      'lib/bot/flows/__tests__/invoice.flow.test.ts',
      'lib/__tests__/p0-invoice-reference-code.test.ts',
      'lib/payments/__tests__/giving-loyalty-gap.test.ts',
      'lib/payments/__tests__/giving-service-type-writers.test.ts',
      'lib/__tests__/acc-166-payment-giving-notification.test.ts',
      'lib/__tests__/acc-224-giving-save-authority.test.ts',
      'lib/bot/flows/__tests__/payment-convergence-giving.test.ts',
      'lib/bot/flows/__tests__/crowdfunding-donation-toggles.test.ts',
      'lib/bot/flows/__tests__/recurring-giving.flow.test.ts',
      'lib/__tests__/capability-contracts/payment-giving.contract.test.ts',
    ],
    invariants: [],
  },
  {
    id: 'migrations-rls-acl',
    label: 'Migrations / RLS / ACL / RPC',
    pathPatterns: [
      'supabase/migrations/',
      'lib/release-gate/',
    ],
    testSuites: [
      'lib/__tests__/release-gate-diff-engine.test.ts',
      'lib/__tests__/release-gate-invariants-db.test.ts',
      'lib/__tests__/release-gate-migration-lint.test.ts',
      'lib/__tests__/release-gate-orchestration.test.ts',
      'lib/__tests__/release-gate-sha-guard.test.ts',
      'lib/__tests__/migration-repair-validator.test.ts',
      'lib/__tests__/p0-table-exposure-db.test.ts',
      'lib/__tests__/p0-table-exposure.test.ts',
      'lib/__tests__/migration-351-acl-hardening-db.test.ts',
      'lib/__tests__/production-drift-reconciliation.test.ts',
    ],
    invariants: ['DB-001', 'DB-002', 'DB-003', 'DB-004', 'DB-005', 'DB-006'],
  },
];

/**
 * Look up which domains are affected by a set of changed file paths.
 * Returns domain IDs whose pathPatterns match at least one changed file.
 */
export function getAffectedDomains(changedFiles: string[]): DomainEntry[] {
  return REGRESSION_MANIFEST.filter(domain =>
    domain.pathPatterns.some(pattern =>
      changedFiles.some(file => file.startsWith(pattern))
    )
  );
}

/**
 * Collect the deduplicated set of required test suites for affected domains.
 */
export function getRequiredTestSuites(domains: DomainEntry[]): string[] {
  const suites = new Set<string>();
  for (const domain of domains) {
    for (const suite of domain.testSuites) {
      suites.add(suite);
    }
  }
  return [...suites].sort();
}

/**
 * Collect the deduplicated set of related invariant IDs.
 */
export function getRelatedInvariants(domains: DomainEntry[]): string[] {
  const ids = new Set<string>();
  for (const domain of domains) {
    for (const inv of domain.invariants) {
      ids.add(inv);
    }
  }
  return [...ids].sort();
}
