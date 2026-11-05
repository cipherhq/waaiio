// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { SettingsTabProps } from '@/app/dashboard/settings/tabs/types';

const session = vi.hoisted(() => ({ setSession: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useCapabilities: () => ({}), useBusiness: () => ({ id: 'business', country_code: 'NG' }) }));
vi.mock('@/components/dashboard/ReAuthModal', () => ({ ReAuthModal: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { setSession: session.setSession,
  mfa: { listFactors: async () => ({ data: { totp: [] }, error: null }) },
} }) }));
import { AccountTab } from '@/app/dashboard/settings/tabs/AccountTab';
import ConnectWhatsAppPage from '@/app/dashboard/whatsapp/connect/page';
const props: SettingsTabProps = {
  business: { id: 'business', name: 'Merchant', subscription_tier: 'free', country_code: 'NG' } as SettingsTabProps['business'],
  capabilities: [], country: 'NG', curr: 'NGN', saving: false, setSaving: vi.fn(), saved: false, setSaved: vi.fn(),
  openSections: ['plan'], toggleSection: vi.fn(),
};
let requests: { url: string; body: any; method: string }[];
let expire: boolean;
let channelReads: number;
const channelInfo = {
  wa_method: 'transfer', channel: { phone_number: '+2348000000000', display_name: 'Existing', connection_status: 'active' },
  shared_targets: [{ id: 'shared-one', phone_number: '+2348000000001', country_code: 'NG' }, { id: 'shared-two', phone_number: '+2348000000002', country_code: 'NG' }],
};
beforeEach(() => {
  requests = []; expire = false; channelReads = 0; vi.clearAllMocks();
  vi.stubGlobal('confirm', vi.fn(() => true)); vi.stubGlobal('prompt', vi.fn(() => '123456')); vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method || 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, method, body });
    if (url.includes('/connection-status')) return Response.json({ active_channel: { id: 'active', ...channelInfo.channel }, candidate: { id: 'candidate-selected', status: 'ready', connection_source: 'embedded_signup', phone_number_display: '+234****1234' } });
    if (url.includes('/step-up/prepare')) return Response.json({ stepUpId: 'authorization' });
    if (url.includes('/step-up/verify')) return Response.json({ session: { access_token: 'refreshed', refresh_token: 'refresh' } });
    if (url.includes('/add-number/finish')) return expire ? Response.json({ error: 'Authorization expired' }, { status: 403 }) : Response.json({ success: true });
    if (url.includes('/settings/whatsapp-channel')) {
      if (method === 'DELETE') return expire ? Response.json({ error: 'Destination changed' }, { status: 409 }) : Response.json({ message: 'Disconnected' });
      channelReads++; return Response.json(channelInfo);
    }
    throw new Error('Unexpected request: ' + url);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('rendered merchant continuity journeys (synthetic HTTP)', () => {
  it('requires an explicit shared destination and carries it through MFA and disconnect', async () => {
    render(<AccountTab {...props} />);
    const select = await screen.findByRole('combobox', { name: 'Shared destination for disconnect' });
    const disconnect = screen.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement;
    expect(disconnect.disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'shared-two' } });
    fireEvent.click(disconnect);
    await screen.findByText(/Using the shared platform number/);
    const prepare = requests.find(item => item.url.endsWith('/step-up/prepare'));
    const execute = requests.find(item => item.method === 'DELETE');
    expect(prepare?.body.target_channel_id).toBe('shared-two');
    expect(execute?.body).toEqual({ business_id: 'business', stepUpId: 'authorization', target_channel_id: 'shared-two' });
    expect(globalThis.confirm).toHaveBeenCalledWith(expect.stringContaining('+2348000000002'));
    expect(session.setSession).toHaveBeenCalledWith({ access_token: 'refreshed', refresh_token: 'refresh' });
  });
  it('reloads destinations and requires a fresh selection after a conflict', async () => {
    expire = true; render(<AccountTab {...props} />);
    const select = await screen.findByRole('combobox', { name: 'Shared destination for disconnect' });
    fireEvent.change(select, { target: { value: 'shared-one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(globalThis.alert).toHaveBeenCalledWith('Destination changed'));
    expect(channelReads).toBe(2);
    expect((select as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('resumes a provider-ready replacement and binds the displayed candidate through MFA and finish', async () => {
    render(<ConnectWhatsAppPage />);
    await screen.findByText('Selected number: +234****1234');
    fireEvent.click(screen.getByRole('button', { name: 'Start verification' }));
    await waitFor(() => expect(requests.some(item => item.url.endsWith('/step-up/prepare'))).toBe(true));
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Verify & Connect' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Verify & Connect' }));
    await waitFor(() => expect(requests.find(item => item.url.endsWith('/add-number/finish'))?.body).toEqual({ business_id: 'business', candidate_id: 'candidate-selected', step_up_id: 'authorization' }));
    expect(requests.find(item => item.url.endsWith('/step-up/prepare'))?.body).toEqual({ business_id: 'business', action_type: 'channel_number_change', candidate_id: 'candidate-selected' });
    expect(session.setSession).toHaveBeenCalled();
  });
  it('invalidates a stale replacement authorization so it cannot be reused', async () => {
    expire = true; render(<ConnectWhatsAppPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start verification' }));
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Verify & Connect' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Verify & Connect' }));
    await screen.findByText('Authorization expired');
    expect(screen.getByRole('button', { name: 'Start verification' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Verify & Connect' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
