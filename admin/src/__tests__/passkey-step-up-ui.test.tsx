/**
 * Admin passkey UI (Owner decision 2026-11-12). The server decides how an
 * operation is confirmed; these tests prove the admin app follows that answer.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { useStepUp } from '../hooks/useStepUp';
import { StepUpDialog } from '../components/StepUpDialog';
import Login from '../pages/Login';

const auth = vi.hoisted(() => ({
  getSession: vi.fn(), setSession: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn(),
  mfa: {
    listFactors: vi.fn(), challenge: vi.fn(), verify: vi.fn(), enroll: vi.fn(), unenroll: vi.fn(),
    webauthn: { authenticate: vi.fn(), register: vi.fn() },
  },
}));
vi.mock('@/lib/supabase', () => ({ supabase: { auth } }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router', async importOriginal => ({ ...(await importOriginal<typeof import('react-router')>()), useNavigate: () => navigate }));

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const PASSKEY = { id: 'pk-1', factor_type: 'webauthn', status: 'verified' };
const TOTP = { id: 'totp-1', factor_type: 'totp', status: 'verified' };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.clearAllMocks();
  auth.getSession.mockResolvedValue({ data: { session: { access_token: 'synthetic' } } });
  auth.setSession.mockResolvedValue({ error: null });
  auth.mfa.listFactors.mockResolvedValue({ data: { all: [TOTP, PASSKEY], totp: [TOTP], webauthn: [PASSKEY] }, error: null });
  auth.mfa.challenge.mockResolvedValue({ data: { id: 'ch-1' }, error: null });
  auth.mfa.webauthn.authenticate.mockResolvedValue({ data: {}, error: null });
});

describe('useStepUp follows the server', () => {
  it('notRequired: runs the operation at once with no grant and no dialog', async () => {
    const fetcher = vi.fn(async () => response({ notRequired: true, method: 'passkey', stepUpId: '' }));
    vi.stubGlobal('fetch', fetcher);
    const onAuthorized = vi.fn(async () => undefined);
    const { result } = renderHook(() => useStepUp());
    await act(async () => {
      await result.current.execute({ actionType: 'payout_generate', targetId: null, params: {}, description: 'x', onAuthorized });
    });
    expect(onAuthorized).toHaveBeenCalledWith('');
    expect(result.current.state.phase).toBe('done');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(auth.mfa.webauthn.authenticate).not.toHaveBeenCalled();
  });

  it('passkey: taps the passkey, verifies with method passkey, then runs the operation', async () => {
    const order: string[] = [];
    auth.mfa.webauthn.authenticate.mockImplementation(async () => { order.push('tap'); return { data: {}, error: null }; });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/prepare')) return response({ stepUpId: 'grant-1', method: 'passkey', factorId: '', challengeId: '' });
      order.push(`verify:${JSON.parse(String(init?.body)).method}`);
      return response({ verified: true });
    });
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useStepUp());
    const op = vi.fn(async (id: string) => { order.push(`op:${id}`); });
    await act(async () => { await result.current.execute({ actionType: 'refund', targetId: 'p', params: {}, description: 'x', onAuthorized: op }); });
    expect(result.current.state.method).toBe('passkey');
    expect(result.current.state.phase).toBe('awaiting-code');
    await act(async () => { await result.current.submitCode('', op); });
    expect(order).toEqual(['tap', 'verify:passkey', 'op:grant-1']);
    expect(auth.mfa.webauthn.authenticate).toHaveBeenCalledWith({ factorId: 'pk-1' });
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it('passkey: a cancelled tap does not call the server or run the operation', async () => {
    auth.mfa.webauthn.authenticate.mockResolvedValue({ data: null, error: new Error('cancelled') });
    const fetcher = vi.fn(async () => response({ stepUpId: 'grant-1', method: 'passkey' }));
    vi.stubGlobal('fetch', fetcher);
    const op = vi.fn(async () => undefined);
    const { result } = renderHook(() => useStepUp());
    await act(async () => { await result.current.execute({ actionType: 'refund', targetId: 'p', params: {}, description: 'x', onAuthorized: op }); });
    await act(async () => { await result.current.submitCode('', op); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(op).not.toHaveBeenCalled();
    expect(result.current.state.error).toMatch(/not confirmed/);
  });

  it('totp is unchanged when the server says totp', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ stepUpId: 'g', factorId: 'totp-1', challengeId: '', method: 'totp' })));
    const { result } = renderHook(() => useStepUp());
    await act(async () => { await result.current.execute({ actionType: 'refund', targetId: 'p', params: {}, description: 'x', onAuthorized: vi.fn() }); });
    expect(result.current.state.method).toBe('totp');
  });
});

describe('StepUpDialog', () => {
  it('passkey mode: no code field; the button submits', () => {
    const onSubmit = vi.fn();
    render(<StepUpDialog open method="passkey" description="Refund" error="" loading={false} onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.queryByPlaceholderText('000000')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use passkey' }));
    expect(onSubmit).toHaveBeenCalledWith('');
  });

  it('default mode still needs six digits', () => {
    const onSubmit = vi.fn();
    render(<StepUpDialog open description="Refund" error="" loading={false} onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Authorize' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    expect(onSubmit).toHaveBeenCalledWith('123456');
  });
});

describe('Login', () => {
  async function signIn() {
    auth.signInWithPassword.mockResolvedValue({ data: { user: { app_metadata: { role: 'admin' } } }, error: null });
    render(<MemoryRouter><Login /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText('admin@waaiio.com'), { target: { value: 'a@test.test' } });
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'pw' } });
    fireEvent.submit(document.querySelector('form')!);
  }

  it('offers passkey sign-in when the account has a verified passkey', async () => {
    await signIn();
    const button = await screen.findByRole('button', { name: 'Sign in with passkey' });
    fireEvent.click(button);
    await waitFor(() => expect(auth.mfa.webauthn.authenticate).toHaveBeenCalledWith({ factorId: 'pk-1' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('keeps code-only sign-in when there is no passkey', async () => {
    auth.mfa.listFactors.mockResolvedValue({ data: { all: [TOTP], totp: [TOTP], webauthn: [] }, error: null });
    await signIn();
    await screen.findByText(/Enter the 6-digit code/);
    expect(screen.queryByRole('button', { name: 'Sign in with passkey' })).toBeNull();
  });
});
