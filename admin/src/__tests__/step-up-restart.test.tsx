import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStepUp } from '../hooks/useStepUp';
const auth = vi.hoisted(() => ({ getSession: vi.fn(), setSession: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.clearAllMocks();
  auth.getSession.mockResolvedValue({ data: { session: { access_token: 'synthetic' } } });
  auth.setSession.mockResolvedValue({ error: null });
});
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const operation = { actionType: 'payout_approve', targetId: 'fixture', params: {}, description: 'Fixture only', onAuthorized: vi.fn() };
describe('step-up one-attempt restart contract', () => {
  it('shows Cancel/restart, blocks stale submission, and permits a fresh prepare', async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith('/prepare')
      ? response({ stepUpId: 'fixture-grant', factorId: 'fixture-factor', challengeId: '' })
      : response({ error: 'Failed', code: 'STEP_UP_RESTART_REQUIRED' }, 400));
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useStepUp());
    await act(async () => { await result.current.execute(operation); });
    expect(result.current.state.challengeId).toBe('');
    await act(async () => { await result.current.submitCode('123456', operation.onAuthorized); });
    expect(result.current.state.phase).toBe('awaiting-code');
    expect(result.current.state.error).toMatch(/Cancel and restart/);
    expect(result.current.state.stepUpId).toBe('');
    await act(async () => { await result.current.submitCode('654321', operation.onAuthorized); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(operation.onAuthorized).not.toHaveBeenCalled(); expect(auth.setSession).not.toHaveBeenCalled();
    act(() => result.current.reset());
    await act(async () => { await result.current.execute(operation); });
    expect(result.current.state.stepUpId).toBe('fixture-grant'); expect(result.current.state.error).toBe('');
  });
  it('persists rotated tokens before executing the unchanged operation callback', async () => {
    const order: string[] = [];
    auth.setSession.mockImplementation(async () => { order.push('session'); return { error: null }; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/prepare')
      ? { stepUpId: 'fixture-grant', factorId: 'fixture-factor', challengeId: '' }
      : { session: { access_token: 'new', refresh_token: 'new-refresh' } })));
    const { result } = renderHook(() => useStepUp());
    await act(async () => { await result.current.execute(operation); });
    await act(async () => { await result.current.submitCode('123456', async id => { expect(id).toBe('fixture-grant'); order.push('operation'); }); });
    expect(order).toEqual(['session', 'operation']); expect(result.current.state.phase).toBe('done');
  });
});
