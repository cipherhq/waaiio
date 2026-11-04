/**
 * incrementAIUsage: calls the atomic increment_ai_usage RPC (service-role
 * only, migration 351) and reports whether the count was saved. Before this
 * fix, a denied write was returned as { error } and silently ignored, so
 * Ace usage was never recorded.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { incrementAIUsage } from '@/lib/bot/ai-tier-guard';
import { logger } from '@/lib/logger';

function client(rpc: (...args: unknown[]) => unknown) {
  return { rpc: vi.fn(rpc), from: vi.fn() } as unknown as Parameters<typeof incrementAIUsage>[0] & { rpc: ReturnType<typeof vi.fn>; from: ReturnType<typeof vi.fn> };
}

describe('incrementAIUsage', () => {
  it('calls the atomic RPC for this month and returns true', async () => {
    const c = client(async () => ({ data: null, error: null }));
    await expect(incrementAIUsage(c, 'biz-1', 'ace_setup')).resolves.toBe(true);
    expect(c.rpc).toHaveBeenCalledWith('increment_ai_usage', {
      p_business_id: 'biz-1',
      p_month_key: new Date().toISOString().slice(0, 7),
      p_field: 'ace_setup_count',
    });
    // No separate read-then-insert path
    expect(c.from).not.toHaveBeenCalled();
  });

  it('returns false and logs when the database refuses the write', async () => {
    const c = client(async () => ({ data: null, error: { message: 'permission denied for function increment_ai_usage' } }));
    await expect(incrementAIUsage(c, 'biz-1', 'ace_setup')).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns false when the call throws', async () => {
    const c = client(async () => { throw new Error('network'); });
    await expect(incrementAIUsage(c, 'biz-1', 'voice_transcription')).resolves.toBe(false);
  });
});
