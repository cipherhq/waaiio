import { describe, it, expect, vi } from 'vitest';
import { logDropoff } from '../flow-analytics';

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function createMockSupabase() {
  const insertFn = vi.fn().mockReturnValue({
    then: (cb: (result: { error: null }) => void) => {
      cb({ error: null });
      return { catch: vi.fn() };
    },
  });
  return {
    from: vi.fn(() => ({ insert: insertFn })),
    _insertFn: insertFn,
  };
}

describe('flow-analytics — logDropoff', () => {
  it('does not throw when businessId is undefined (no-op)', () => {
    const supabase = createMockSupabase();
    expect(() => {
      logDropoff(supabase as any, {
        businessId: undefined,
        flowType: 'scheduling',
        stepId: 'select_service',
        reason: 'cancelled',
      });
    }).not.toThrow();
    // Should not call supabase when businessId is missing
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('calls supabase insert with correct params', () => {
    const supabase = createMockSupabase();
    logDropoff(supabase as any, {
      businessId: 'biz-001',
      flowType: 'scheduling',
      stepId: 'select_service',
      reason: 'cancelled',
      capability: 'scheduling',
    });
    expect(supabase.from).toHaveBeenCalledWith('flow_dropoffs');
    expect(supabase._insertFn).toHaveBeenCalledWith({
      business_id: 'biz-001',
      flow_type: 'scheduling',
      step_id: 'select_service',
      reason: 'cancelled',
      capability: 'scheduling',
    });
  });
});
