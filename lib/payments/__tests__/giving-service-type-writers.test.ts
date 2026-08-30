/**
 * #167 SERVICE-TYPE WRITER INVARIANT TESTS — executable production-path proof
 *
 * Imports and executes the exact payload builder functions called by:
 *   - app/dashboard/giving/page.tsx → buildGivingServicePayload
 *   - app/dashboard/services/page.tsx → buildServicePayload
 *   - app/api/ai-setup/apply/route.ts → buildAiSetupServiceRow
 *
 * Proves the write contract the Stage 3 loyalty classifier depends on.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildGivingServicePayload,
  buildServicePayload,
  buildAiSetupServiceRow,
} from '@/lib/services/payload-builders';

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../../..', relPath), 'utf-8');
}

// ── Executable Giving payload tests ──

describe('#167 executable writer: Giving create/edit', () => {
  it('creating a Giving service writes service_type=giving', () => {
    const payload = buildGivingServicePayload({
      businessId: 'biz-1', name: 'Sunday Tithes', description: 'Weekly tithe',
      fixedAmount: false, price: 0, isRecurring: false, interval: 'monthly',
    });
    expect(payload.service_type).toBe('giving');
  });

  it('editing/resaving a Giving service preserves service_type=giving', () => {
    const payload = buildGivingServicePayload({
      businessId: 'biz-1', name: 'Renamed Offering', description: 'Updated',
      fixedAmount: true, price: 5000, isRecurring: true, interval: 'weekly',
    });
    expect(payload.service_type).toBe('giving');
  });

  it('variable-amount Giving sets price=0 and price_is_variable=true', () => {
    const payload = buildGivingServicePayload({
      businessId: 'biz-1', name: 'Offering', description: '',
      fixedAmount: false, price: 99999, isRecurring: false, interval: 'monthly',
    });
    expect(payload.service_type).toBe('giving');
    expect(payload.price).toBe(0);
    expect(payload.price_is_variable).toBe(true);
  });

  it('fixed-amount Giving preserves exact price', () => {
    const payload = buildGivingServicePayload({
      businessId: 'biz-1', name: 'Building Fund', description: '',
      fixedAmount: true, price: 10000, isRecurring: false, interval: 'monthly',
    });
    expect(payload.service_type).toBe('giving');
    expect(payload.price).toBe(10000);
    expect(payload.price_is_variable).toBe(false);
  });
});

// ── Executable Services payload tests ──

describe('#167 executable writer: Services create/edit', () => {
  const baseInput = {
    businessId: 'biz-1', name: 'Haircut', description: 'Standard cut' as string | null,
    price: 5000, price_is_variable: false, duration_minutes: 30,
    buffer_minutes: 0, deposit_amount: 0, status: 'active', sort_order: 0,
    billing_type: 'one_time', is_featured: false, is_package: false,
    included_service_ids: [] as string[], gallery_urls: [] as string[],
    quote_enabled: false, is_class: false, requires_staff: false,
    staff_ids: [] as string[], allow_staff_selection: false,
  };

  it('ordinary service creation does not include service_type', () => {
    const payload = buildServicePayload(baseInput);
    expect(payload).not.toHaveProperty('service_type');
  });

  it('ordinary service editing does not silently become Giving', () => {
    const payload = buildServicePayload({
      ...baseInput, name: 'Updated Haircut', price: 7500, is_featured: true,
    });
    expect(payload).not.toHaveProperty('service_type');
  });

  it('service with staff/package fields still excludes service_type', () => {
    const payload = buildServicePayload({
      ...baseInput, requires_staff: true, staff_ids: ['s1', 's2'],
      allow_staff_selection: true, is_package: true, included_service_ids: ['svc-a'],
    });
    expect(payload).not.toHaveProperty('service_type');
    expect(payload.staff_ids).toEqual(['s1', 's2']);
  });
});

// ── Executable AI Setup payload tests ──

describe('#167 executable writer: AI Setup service creation', () => {
  it('AI Setup service creation does not include service_type', () => {
    const row = buildAiSetupServiceRow({
      businessId: 'biz-1', name: 'Consultation', price: 3000,
      duration_minutes: 60, deposit_amount: 0, sortOrder: 0,
    });
    expect(row).not.toHaveProperty('service_type');
  });

  it('AI Setup enforces bounds without service_type', () => {
    const row = buildAiSetupServiceRow({
      businessId: 'biz-1', name: 'A'.repeat(300), price: 999999999,
      duration_minutes: 9999, deposit_amount: -100,
      description: 'B'.repeat(2000), sortOrder: 5,
    });
    expect(row).not.toHaveProperty('service_type');
    expect(row.name.length).toBe(200);
    expect(row.price).toBe(99999999);
    expect(row.duration_minutes).toBe(1440);
    expect(row.deposit_amount).toBe(0);
    expect(row.description!.length).toBe(1000);
  });
});

// ── Structural guards: pages call extracted builders ──

describe('#167 structural guard: pages call extracted builders', () => {
  it('Giving save API route imports and calls buildGivingServicePayload', () => {
    // #224: Giving saves now go through server-authoritative API route
    const src = readSource('app/api/giving/save/route.ts');
    expect(src).toContain("from '@/lib/services/payload-builders'");
    expect(src).toContain('buildGivingServicePayload');
  });

  it('Giving page delegates saves to /api/giving/save', () => {
    const src = readSource('app/dashboard/giving/page.tsx');
    expect(src).toContain('/api/giving/save');
  });

  it('Services page imports and calls buildServicePayload', () => {
    const src = readSource('app/dashboard/services/page.tsx');
    expect(src).toContain("from '@/lib/services/payload-builders'");
    expect(src).toContain('buildServicePayload');
  });

  it('AI Setup route imports and calls buildAiSetupServiceRow', () => {
    const src = readSource('app/api/ai-setup/apply/route.ts');
    expect(src).toContain("from '@/lib/services/payload-builders'");
    expect(src).toContain('buildAiSetupServiceRow');
  });

  it('Giving page only fetches giving-type services', () => {
    const src = readSource('app/dashboard/giving/page.tsx');
    expect(src).toContain(".eq('service_type', 'giving')");
  });

  it('Services page excludes giving-type services from fetch', () => {
    const src = readSource('app/dashboard/services/page.tsx');
    expect(src).toContain(".neq('service_type', 'giving')");
  });
});
