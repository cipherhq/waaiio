/**
 * #376 Deposit amount authority.
 *
 * Covers write-path validation and the runtime guard that all scheduling
 * payment methods consume before provider/payment initialization.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  assertValidDepositConfiguration,
  getDepositConfigurationError,
  resolveRuntimeDeposit,
} from '@/lib/payments/deposit-amount-authority';
import { buildServicePayload } from '@/lib/services/payload-builders';

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../../..', relPath), 'utf-8');
}

const serviceBase = {
  businessId: 'biz-1',
  name: 'Fixed service',
  description: null as string | null,
  price: 100,
  price_is_variable: false,
  duration_minutes: 30,
  buffer_minutes: 0,
  deposit_amount: 0,
  status: 'active',
  sort_order: 0,
  billing_type: 'one_time',
  recurring_interval: null as string | null,
  is_featured: false,
  image_url: null as string | null,
  cancellation_policy: null as string | null,
  available_days: [] as string[],
  available_from: null as string | null,
  available_to: null as string | null,
  requires_staff: false,
  staff_ids: [] as string[],
  allow_staff_selection: false,
  is_package: false,
  included_service_ids: [] as string[],
  gallery_urls: [] as string[],
  quote_enabled: false,
  is_class: false,
  class_schedule: [] as unknown[],
  max_capacity: 1,
  metadata: {} as Record<string, unknown>,
};

describe('#376 fixed-price configuration authority', () => {
  it('rejects price 100 / deposit 200', () => {
    expect(getDepositConfigurationError({
      price: 100, deposit: 200, priceIsVariable: false,
    })).toMatch(/cannot exceed the price/i);

    expect(() => assertValidDepositConfiguration({
      price: 100, deposit: 200, priceIsVariable: false,
    })).toThrow(RangeError);

    expect(() => buildServicePayload({
      ...serviceBase, price: 100, deposit_amount: 200,
    })).toThrow(/deposit cannot exceed/i);
  });

  it('allows deposit equal to fixed price', () => {
    expect(getDepositConfigurationError({
      price: 100, deposit: 100, priceIsVariable: false,
    })).toBeNull();
    expect(buildServicePayload({
      ...serviceBase, price: 100, deposit_amount: 100,
    }).deposit_amount).toBe(100);
  });

  it('allows deposit below fixed price', () => {
    expect(getDepositConfigurationError({
      price: 100, deposit: 40, priceIsVariable: false,
    })).toBeNull();
  });

  it('keeps zero/no deposit unchanged', () => {
    expect(resolveRuntimeDeposit({
      requestedDeposit: 0, transactionTotal: 100, priceIsVariable: false,
    })).toEqual({ amount: 0, corrected: false });
  });

  it('allows variable-price deposit above configured starting price', () => {
    expect(getDepositConfigurationError({
      price: 100, deposit: 200, priceIsVariable: true,
    })).toBeNull();
    expect(buildServicePayload({
      ...serviceBase,
      price: 100,
      price_is_variable: true,
      deposit_amount: 200,
    }).deposit_amount).toBe(200);
  });
});

describe('#376 runtime financial authority', () => {
  it('legacy fixed price 100 / deposit 200 can never initialize above 100', () => {
    expect(resolveRuntimeDeposit({
      requestedDeposit: 200,
      transactionTotal: 100,
      priceIsVariable: false,
    })).toEqual({
      amount: 100,
      corrected: true,
      reason: 'deposit_exceeds_transaction_total',
    });
  });

  it('also caps against discounted transaction total', () => {
    expect(resolveRuntimeDeposit({
      requestedDeposit: 100,
      transactionTotal: 80,
      priceIsVariable: false,
    }).amount).toBe(80);
  });

  it('preserves variable-price runtime semantics', () => {
    expect(resolveRuntimeDeposit({
      requestedDeposit: 200,
      transactionTotal: 100,
      priceIsVariable: true,
    })).toEqual({ amount: 200, corrected: false });
  });

  it('fails closed on negative/invalid runtime deposit', () => {
    expect(resolveRuntimeDeposit({
      requestedDeposit: -20,
      transactionTotal: 100,
      priceIsVariable: false,
    })).toEqual({
      amount: 0,
      corrected: true,
      reason: 'negative_or_invalid',
    });
  });
});

describe('#376 production wiring guards', () => {
  it('appointment and service dashboards validate before writing', () => {
    const appointments = readSource('app/dashboard/appointments-management/page.tsx');
    const services = readSource('app/dashboard/services/page.tsx');
    expect(appointments).toContain('getDepositConfigurationError');
    expect(services).toContain('getDepositConfigurationError');
  });

  it('appointment flow carries price_is_variable into scheduling authority', () => {
    const src = readSource('lib/bot/flows/appointment.flow.ts');
    expect(src).toContain('price_is_variable');
    expect(src).toContain('_service_price_is_variable');
  });

  it('card, saved-card, and bank-transfer paths share corrected totalDeposit', () => {
    const src = readSource('lib/bot/flows/scheduling.flow.ts');
    expect(src).toContain('resolveRuntimeDeposit({');
    expect(src).toContain('transactionTotal: finalServicePrice * partySize');
    expect(src).toContain('d._pending_deposit = totalDeposit');
    expect(src).toContain('amount: totalDeposit,');
    expect(src).toContain('d.bank_transfer_amount = totalDeposit');
    expect(src).toContain('const amount = d._pending_deposit as number');
  });

  it('booking total uses transaction authority instead of deposit amount', () => {
    const src = readSource('lib/bot/flows/scheduling.flow.ts');
    expect(src).toContain('const bookingTotalAmount =');
    expect(src).toContain('total_amount: bookingTotalAmount');
    expect(src).toContain('p_total_amount: bookingTotalAmount');
  });

  it('database constraints enforce future writes without invalidating legacy rows', () => {
    const migration = readSource('supabase/migrations/399_deposit_amount_authority.sql');
    expect(migration).toContain('appointments_deposit_amount_authority_chk');
    expect(migration).toContain('services_deposit_amount_authority_chk');
    expect((migration.match(/NOT VALID/g) || []).length).toBe(2);
    expect(migration).toContain('COALESCE(price_is_variable, false)');
  });
});
