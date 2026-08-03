/**
 * CAS-005 — Unavailable-capability recovery behavioral tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildRecoveryMessage, buildCapabilityRecoveryMessage, clearRejectedTransactionalState } from '../capability-recovery';
import type { CapabilityId } from '@/lib/capabilities/types';

describe('CAS-005 recovery message', () => {
  it('1. sole-capability mismatch shows alternatives', () => {
    const msg = buildRecoveryMessage({
      requestedFamily: 'property_reservation',
      effectiveUserFacing: ['ordering'] as CapabilityId[],
      businessCategory: 'restaurant',
    });
    expect(msg).toContain('not available');
    expect(msg).not.toContain('property_reservation'); // internal family ID not exposed
    expect(msg).toContain('You can still');
  });

  it('2. multi-capability shows valid alternatives only', () => {
    const msg = buildRecoveryMessage({
      requestedFamily: 'property_reservation',
      effectiveUserFacing: ['scheduling', 'ordering'] as CapabilityId[],
      businessCategory: 'restaurant',
    });
    expect(msg).toContain('not available');
    expect(msg).toContain('You can still');
  });

  it('3. available family does NOT trigger recovery', async () => {
    const { resolveSemanticCapability } = await import('../semantic-resolver');
    const res = resolveSemanticCapability('property_reservation', 'create_new', ['reservation'] as CapabilityId[]);
    expect(res.canRoute).toBe(true);
  });

  it('5. unavailable cap_ button gets recovery', () => {
    const msg = buildCapabilityRecoveryMessage('scheduling', ['ordering'] as CapabilityId[], 'salon');
    expect(msg).toContain('not available');
  });

  it('7. quick rebook unavailable gets recovery', () => {
    const msg = buildCapabilityRecoveryMessage('scheduling', ['ordering'] as CapabilityId[], 'salon');
    expect(msg).toContain('not available');
    expect(msg).toContain('You can still');
  });

  it('22. no alternatives → start over', () => {
    const msg = buildRecoveryMessage({
      requestedFamily: 'property_reservation',
      effectiveUserFacing: [] as CapabilityId[],
      businessCategory: 'hotel',
    });
    expect(msg).toContain('not available');
    expect(msg).toContain('Hi');
    expect(msg).not.toContain('You can still');
  });

  it('no internal IDs exposed', () => {
    const msg = buildRecoveryMessage({
      requestedFamily: 'property_reservation',
      effectiveUserFacing: ['scheduling', 'ordering'] as CapabilityId[],
      businessCategory: 'salon',
    });
    expect(msg).not.toContain('property_reservation');
    expect(msg).not.toContain('service_time_booking');
    expect(msg).not.toContain('CapabilityId');
  });
});

describe('CAS-005 state cleanup', () => {
  it('17. clears all transactional fields', () => {
    const sd: Record<string, unknown> = {
      business_id: 'biz-1', business_name: 'Test', capabilities: ['scheduling'],
      active_capability: 'reservation', service_id: 'svc-1', service_name: 'Room',
      service_price: 100, date: '2026-09-01', time: '14:00', party_size: 2,
      ticket_quantity: 2, amount: 500, cart: [{ id: 'p1' }],
      _auto_added_to_cart: true, _skip_browse: true, _matched_product_ids: ['p1'],
      _quick_rebook_service_id: 'svc-1', _deep_link_capability: 'reservation',
    };

    clearRejectedTransactionalState(sd);

    // Cleared
    expect(sd.active_capability).toBeUndefined();
    expect(sd.service_id).toBeUndefined();
    expect(sd.date).toBeUndefined();
    expect(sd.time).toBeUndefined();
    expect(sd.party_size).toBeUndefined();
    expect(sd.amount).toBeUndefined();
    expect(sd.cart).toBeUndefined();
    expect(sd._quick_rebook_service_id).toBeUndefined();
    expect(sd._deep_link_capability).toBeUndefined();

    // Preserved
    expect(sd.business_id).toBe('biz-1');
    expect(sd.business_name).toBe('Test');
    expect(sd.capabilities).toBeDefined();
  });

  it('idempotent — double call safe', () => {
    const sd: Record<string, unknown> = { business_id: 'biz-1', service_id: 'svc-1' };
    clearRejectedTransactionalState(sd);
    clearRejectedTransactionalState(sd);
    expect(sd.business_id).toBe('biz-1');
    expect(sd.service_id).toBeUndefined();
  });
});

describe('CAS-005 capability-selection recovery', () => {
  it('unavailable free text → recovery with alternatives', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['ordering'] },
      },
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'restaurant' as any, flow_type: 'ordering' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!('I want to reserve a room', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('not available');
    expect(result.errorMessage).toContain('You can still');
    // Transactional state should be cleaned
    expect(ctx.session.session_data.active_capability).toBeUndefined();
  });

  it('available free text → no recovery', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['ordering'] },
      },
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'restaurant' as any, flow_type: 'ordering' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!('I want to order food', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.active_capability).toBe('ordering');
  });
});

describe('CAS-005 commit-guard recovery', () => {
  it('12. trial-expired commit guard has recovery message', async () => {
    const { requireCurrentCapability } = await import('../flows/shared/capability-guard');

    // Table-aware mock
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          const c: Record<string, any> = {}; c.select = () => c; c.eq = () => c;
          c.single = vi.fn().mockResolvedValue({ data: { id: 'b1', status: 'active', subscription_tier: 'free', trial_ends_at: '2024-01-01', category: 'hotel' }, error: null });
          return c;
        }
        if (table === 'business_capabilities') {
          const d = Promise.resolve({ data: [{ capability: 'reservation', is_enabled: true, sort_order: 0 }], error: null });
          return { select: () => ({ eq: () => ({ order: () => ({ order: () => ({ then: d.then.bind(d), catch: d.catch.bind(d) }) }) }) }) };
        }
        if (table === 'capability_overrides') {
          const d = Promise.resolve({ data: [], error: null });
          return { select: () => ({ eq: () => ({ then: d.then.bind(d), catch: d.catch.bind(d) }) }) };
        }
        const c: Record<string, any> = {};
        for (const m of ['select','eq','order']) c[m] = () => c;
        c.single = vi.fn().mockResolvedValue({ data: null, error: null });
        return c;
      }),
    } as any;

    const result = await requireCurrentCapability(supabase, {
      businessId: 'b1', capability: 'reservation', action: 'create_new',
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.customerMessage).toContain('not available');
      // Should NOT contain internal IDs
      expect(result.customerMessage).not.toContain('trial_expired');
      expect(result.customerMessage).not.toContain('tier_required');
    }
  });
});
