import { vi } from 'vitest';
import type { FlowContext, FlowStepConfig } from '../types';

/**
 * Create a mock Supabase client for testing flow steps.
 * Methods are chainable and return configurable results.
 */
export function createMockSupabase(overrides: Record<string, unknown> = {}) {
  const chainable = () => {
    const chain: Record<string, unknown> = {
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    return chain;
  };

  return {
    from: vi.fn(() => chainable()),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides,
  };
}

/** Create a mock FlowContext for testing */
export function createMockContext(overrides: Partial<FlowContext> = {}): FlowContext {
  return {
    supabase: createMockSupabase() as any,
    sender: {
      sendText: vi.fn().mockResolvedValue({}),
      sendButtons: vi.fn().mockResolvedValue({}),
      sendList: vi.fn().mockResolvedValue({}),
      sendDocument: vi.fn().mockResolvedValue({}),
    } as any,
    standalone: {} as any,
    intelligence: {} as any,
    t: vi.fn(async (text: string) => text),
    from: '+2341234567890',
    session: {
      id: 'test-session-id',
      user_id: 'test-user-id',
      business_id: 'test-business-id',
      current_step: '',
      session_data: {},
    },
    business: {
      id: 'test-business-id',
      name: 'Test Business',
      slug: 'test-business',
      category: 'other' as any,
      flow_type: 'scheduling' as any,
      subscription_tier: 'starter',
      trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
      metadata: {},
    },
    ...overrides,
  };
}

/** Helper to get a step from a flow by ID */
export function getStep(flow: { steps: FlowStepConfig[] }, stepId: string): FlowStepConfig {
  const step = flow.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`Step "${stepId}" not found in flow`);
  return step;
}
