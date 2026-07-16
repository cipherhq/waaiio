import { describe, it, expect, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { capabilitySelectionFlow, getCapabilityLabel } from '../capability-selection.flow';

describe('Capability Selection Flow', () => {
  const step = getStep(capabilitySelectionFlow, 'select_capability');

  it('flow has all 4 steps registered', () => {
    const stepIds = capabilitySelectionFlow.steps.map(s => s.id);
    expect(stepIds).toContain('select_capability');
    expect(stepIds).toContain('my_account_menu');
    expect(stepIds).toContain('my_bookings');
    expect(stepIds).toContain('my_orders');
  });

  it('validates capability selection by postback (cap_scheduling)', async () => {
    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['scheduling', 'payment'] },
      },
    });

    const result = await step.validate('cap_scheduling', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.active_capability).toBe('scheduling');
  });

  it('validates capability selection by numeric index', async () => {
    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['scheduling', 'payment'], business_category: 'other' },
      },
    });

    const result = await step.validate('1', ctx);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid capability selection', async () => {
    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['scheduling'] },
      },
    });

    const result = await step.validate('nonexistent', ctx);
    expect(result.valid).toBe(false);
  });

  it('getCapabilityLabel returns correct labels', () => {
    expect(getCapabilityLabel('scheduling' as any, 'other')).toBe('Our Services');
    expect(getCapabilityLabel('ordering' as any, 'other')).toContain('Order');
    expect(getCapabilityLabel('ticketing' as any, 'other')).toContain('Ticket');
    expect(getCapabilityLabel('giving' as any, 'other')).toContain('Give');
    expect(getCapabilityLabel('chat' as any, 'other')).toContain('Chat');
  });
});
