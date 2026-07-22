/**
 * Payment Source Classification Tests
 *
 * Verifies the payment information architecture:
 * - payment_source column separates intent from channel
 * - Payment Requests page excludes subscriptions
 * - Payments Received page shows all successful payments
 * - Source classification is correct
 * - Migration is safe
 * - Tenant isolation is maintained
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const requestPageCode = readFileSync('app/dashboard/payment-request/page.tsx', 'utf-8');
const paymentsPageCode = readFileSync('app/dashboard/payments/page.tsx', 'utf-8');
const sendRouteCode = readFileSync('app/api/payment-request/send/route.ts', 'utf-8');
const botPaymentCode = readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');
const stripeWebhookCode = readFileSync('app/api/payments/stripe-webhook/route.ts', 'utf-8');
const migrationCode = readFileSync('supabase/migrations/244_payment_source_classification.sql', 'utf-8');
const sidebarCode = readFileSync('components/dashboard/Sidebar.tsx', 'utf-8');

// ── Payment Requests page ──

describe('Payment Requests page', () => {
  it('page title is Payment Requests', () => {
    expect(requestPageCode).toContain('>Payment Requests<');
  });

  it('queries bookings with flow_type=payment', () => {
    expect(requestPageCode).toContain(".eq('flow_type', 'payment')");
  });

  it('filters to payment_source=payment_request only', () => {
    expect(requestPageCode).toContain(".eq('payment_source', 'payment_request')");
  });

  it('queries by business_id for tenant isolation', () => {
    expect(requestPageCode).toContain(".eq('business_id', business.id)");
  });

  it('uses browser client (RLS enforced)', () => {
    expect(requestPageCode).toContain("from '@/lib/supabase/client'");
  });

  it('selects payment_source column', () => {
    expect(requestPageCode).toContain('payment_source');
  });

  it('selects channel column', () => {
    expect(requestPageCode).toContain('channel');
  });

  it('has Source column in table header', () => {
    expect(requestPageCode).toContain('>Source<');
  });

  it('has Provider column in table header', () => {
    expect(requestPageCode).toContain('>Provider<');
  });

  it('has getSource function mapping channel to label', () => {
    expect(requestPageCode).toContain('function getSource');
    expect(requestPageCode).toContain("'Dashboard'");
    expect(requestPageCode).toContain("'WhatsApp'");
    expect(requestPageCode).toContain("'API'");
  });

  it('has getProvider function', () => {
    expect(requestPageCode).toContain('function getProvider');
  });
});

// ── Payments Received page ──

describe('Payments Received page', () => {
  it('page title is Payments Received', () => {
    expect(paymentsPageCode).toContain('>Payments Received<');
  });

  it('queries payments table (not bookings)', () => {
    expect(paymentsPageCode).toContain(".from('payments')");
  });

  it('filters to successful payments', () => {
    expect(paymentsPageCode).toContain(".eq('status', 'success')");
  });

  it('excludes soft-deleted payments', () => {
    expect(paymentsPageCode).toContain(".is('deleted_at', null)");
  });

  it('queries by business_id for tenant isolation', () => {
    expect(paymentsPageCode).toContain(".eq('business_id', business.id)");
  });

  it('uses browser client (RLS enforced)', () => {
    expect(paymentsPageCode).toContain("from '@/lib/supabase/client'");
  });

  it('joins booking data for source classification', () => {
    expect(paymentsPageCode).toContain('bookings');
    expect(paymentsPageCode).toContain('payment_source');
    expect(paymentsPageCode).toContain('flow_type');
  });

  it('uses inner join for booking-column source filters', () => {
    expect(paymentsPageCode).toContain("bookings!inner");
  });

  it('uses server-side filtering via PostgREST (no client-side filter after pagination)', () => {
    // Verify source filters use .eq on bookings columns (server-side via !inner join)
    expect(paymentsPageCode).toContain(".eq('bookings.payment_source', 'payment_request')");
    expect(paymentsPageCode).toContain(".eq('bookings.payment_source', 'subscription')");
    expect(paymentsPageCode).toContain(".eq('bookings.payment_source', 'booking')");
    expect(paymentsPageCode).toContain(".eq('bookings.payment_source', 'event')");
    // Verify no client-side .filter() after data fetch
    expect(paymentsPageCode).not.toContain('filtered = filtered.filter');
  });

  it('uses server-side search via ilike', () => {
    expect(paymentsPageCode).toContain('.ilike(');
  });

  it('always uses server-side count', () => {
    expect(paymentsPageCode).toContain('setTotalCount(count ?? 0)');
    expect(paymentsPageCode).not.toContain('filtered.length');
  });

  it('debounces search input', () => {
    expect(paymentsPageCode).toContain('debouncedSearch');
    expect(paymentsPageCode).toContain('setTimeout');
  });

  it('classifies all payment source types', () => {
    expect(paymentsPageCode).toContain("label: 'Payment Request'");
    expect(paymentsPageCode).toContain("label: 'WhatsApp'");
    expect(paymentsPageCode).toContain("label: 'Subscription'");
    expect(paymentsPageCode).toContain("label: 'Booking'");
    expect(paymentsPageCode).toContain("label: 'Invoice'");
    expect(paymentsPageCode).toContain("label: 'Event'");
    expect(paymentsPageCode).toContain("label: 'Order'");
    expect(paymentsPageCode).toContain("label: 'Donation'");
    expect(paymentsPageCode).toContain("label: 'Other'");
  });

  it('has source filter buttons', () => {
    expect(paymentsPageCode).toContain("key: 'all'");
    expect(paymentsPageCode).toContain("key: 'payment_request'");
    expect(paymentsPageCode).toContain("key: 'subscription'");
    expect(paymentsPageCode).toContain("key: 'booking'");
    expect(paymentsPageCode).toContain("key: 'invoice'");
    expect(paymentsPageCode).toContain("key: 'event'");
    expect(paymentsPageCode).toContain("key: 'order'");
  });

  it('has search input', () => {
    expect(paymentsPageCode).toContain('Search by name, phone, or reference');
  });

  it('has pagination', () => {
    expect(paymentsPageCode).toContain('.range(from, to)');
    expect(paymentsPageCode).toContain("{ count: 'exact' }");
    expect(paymentsPageCode).toContain('[25, 50, 100]');
  });

  it('has deterministic ordering with tie-breakers', () => {
    expect(paymentsPageCode).toContain("order('paid_at'");
    expect(paymentsPageCode).toContain("order('created_at'");
    expect(paymentsPageCode).toContain("order('id'");
  });

  it('has stale response protection', () => {
    expect(paymentsPageCode).toContain('fetchIdRef');
    expect(paymentsPageCode).toContain('if (fetchId !== fetchIdRef.current) return');
  });

  it('has empty state', () => {
    expect(paymentsPageCode).toContain('No payments received yet');
  });

  it('has loading state', () => {
    expect(paymentsPageCode).toContain('Loading payments');
  });

  it('has error state with retry', () => {
    expect(paymentsPageCode).toContain('Failed to load payments');
    expect(paymentsPageCode).toContain('Retry');
  });

  it('has detail modal', () => {
    expect(paymentsPageCode).toContain('role="dialog"');
    expect(paymentsPageCode).toContain('Payment Details');
  });

  it('has modal focus management', () => {
    expect(paymentsPageCode).toContain('ref={modalRef}');
    expect(paymentsPageCode).toContain('triggerRef');
  });

  it('has keyboard-accessible table rows', () => {
    expect(paymentsPageCode).toContain('tabIndex={0}');
    expect(paymentsPageCode).toContain('role="button"');
  });

  it('has responsive hidden columns', () => {
    expect(paymentsPageCode).toContain('hidden sm:table-cell');
    expect(paymentsPageCode).toContain('hidden md:table-cell');
    expect(paymentsPageCode).toContain('hidden lg:table-cell');
  });
});

// ── Source tagging at creation ──

describe('Source tagging at creation', () => {
  it('dashboard send route sets payment_source=payment_request', () => {
    expect(sendRouteCode).toContain("payment_source: 'payment_request'");
  });

  it('WhatsApp bot payment flow sets payment_source=payment_request', () => {
    expect(botPaymentCode).toContain("payment_source: 'payment_request'");
  });

  it('Stripe recurring webhook sets payment_source=subscription', () => {
    const matches = stripeWebhookCode.match(/payment_source: 'subscription'/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it('channel and payment_source are independent concepts', () => {
    // Bot sets channel=whatsapp AND payment_source=payment_request
    expect(botPaymentCode).toContain("channel: 'whatsapp'");
    expect(botPaymentCode).toContain("payment_source: 'payment_request'");
    // Stripe sets channel=recurring AND payment_source=subscription
    expect(stripeWebhookCode).toContain("channel: 'recurring'");
    expect(stripeWebhookCode).toContain("payment_source: 'subscription'");
  });
});

// ── Migration safety ──

describe('Migration 244', () => {
  it('adds payment_source as nullable TEXT (not enum)', () => {
    expect(migrationCode).toContain('ADD COLUMN IF NOT EXISTS payment_source TEXT');
  });

  it('has CHECK constraint for allowed values', () => {
    expect(migrationCode).toContain('bookings_payment_source_check');
    expect(migrationCode).toContain("'payment_request'");
    expect(migrationCode).toContain("'subscription'");
    expect(migrationCode).toContain("'booking'");
    expect(migrationCode).toContain("'invoice'");
    expect(migrationCode).toContain("'event'");
    expect(migrationCode).toContain("'order'");
    expect(migrationCode).toContain("'donation'");
    expect(migrationCode).toContain("'other'");
  });

  it('is idempotent (IF NOT EXISTS guards)', () => {
    expect(migrationCode).toContain('ADD COLUMN IF NOT EXISTS');
    expect(migrationCode).toContain('IF NOT EXISTS');
    expect(migrationCode).toContain('CREATE INDEX IF NOT EXISTS');
    // Backfills use payment_source IS NULL guard
    expect(migrationCode).toContain('AND payment_source IS NULL');
  });

  it('backfills dashboard requests with safe heuristic', () => {
    expect(migrationCode).toContain("SET payment_source = 'payment_request'");
    expect(migrationCode).toContain("service_id IS NULL");
    expect(migrationCode).toContain("time = '00:00'");
    expect(migrationCode).toContain("status = 'confirmed'");
  });

  it('backfills WhatsApp bot requests', () => {
    expect(migrationCode).toContain("channel = 'whatsapp'");
    expect(migrationCode).toContain("service_id IS NOT NULL");
  });

  it('backfills subscriptions by notes pattern', () => {
    expect(migrationCode).toContain("notes LIKE 'Recurring %'");
    expect(migrationCode).toContain("SET payment_source = 'subscription'");
  });

  it('backfills other flow types', () => {
    expect(migrationCode).toContain("SET payment_source = 'event'");
    expect(migrationCode).toContain("flow_type = 'ticketing'");
    expect(migrationCode).toContain("SET payment_source = 'booking'");
    expect(migrationCode).toContain("SET payment_source = 'order'");
  });

  it('does not delete any records', () => {
    expect(migrationCode).not.toContain('DELETE FROM');
    expect(migrationCode).not.toContain('TRUNCATE');
    expect(migrationCode).not.toContain('DROP TABLE');
  });

  it('updates the recurring charge RPC to include payment_source', () => {
    expect(migrationCode).toContain("'subscription'");
    expect(migrationCode).toContain('process_recurring_charge');
    expect(migrationCode).toContain('payment_source');
  });

  it('includes preview queries for pre-deploy verification', () => {
    expect(migrationCode).toContain('Preview queries');
    expect(migrationCode).toContain('SELECT COUNT(*)');
  });

  it('adds RLS policy for payments via business_id', () => {
    expect(migrationCode).toContain('Owners view payments by business');
    expect(migrationCode).toContain('business_id IN');
    expect(migrationCode).toContain('owner_id = auth.uid()');
  });

  it('documents the RLS gap being addressed', () => {
    expect(migrationCode).toContain('booking_id IS NULL are invisible');
    expect(migrationCode).toContain('does NOT weaken tenant isolation');
  });
});

// ── Navigation ──

describe('Sidebar navigation', () => {
  it('has Payment Requests nav item', () => {
    expect(sidebarCode).toContain("label: 'Payment Requests'");
    expect(sidebarCode).toContain("href: '/dashboard/payment-request'");
  });

  it('has Payments Received nav item', () => {
    expect(sidebarCode).toContain("label: 'Payments Received'");
    expect(sidebarCode).toContain("href: '/dashboard/payments'");
  });

  it('has Payouts nav item (separate from Payments Received)', () => {
    expect(sidebarCode).toContain("label: 'Payouts'");
    expect(sidebarCode).toContain("href: '/dashboard/payouts'");
  });
});
