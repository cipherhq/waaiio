// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'biz-1', name: 'Merchant', country_code: 'US' }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: () => <input aria-label="Direct phone" /> }));
import ConnectWhatsAppPage from '@/app/dashboard/whatsapp/connect/page';
const fetchMock = vi.fn();
let loginResponse: object;
let callbackStatus: number;
const accounts = [{ waba_id: 'account-1', waba_name: 'Merchant account', phones: [
  { id: 'phone-1', display_phone_number: '+15550000001', verified_name: 'First' },
  { id: 'phone-2', display_phone_number: '+15550000002', verified_name: 'Second' },
] }];
beforeEach(() => {
  loginResponse = { authResponse: { code: 'meta-code' } }; callbackStatus = 200;
  vi.stubEnv('NEXT_PUBLIC_META_APP_ID', 'app-1');
  vi.stubEnv('NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID', 'config-1');
  vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('connection-status')) return Response.json({ active_channel: null, candidate: null });
    if (url.includes('readiness')) return Response.json({ message: 'Not enabled' });
    if (url.endsWith('/discover')) return Response.json({ connection_id: 'handle-1', wabas: accounts });
    if (url.endsWith('/callback')) return Response.json(callbackStatus === 200
      ? { connection_status: 'active', phone_number: '+15550000001' }
      : { message: 'Registration failed' }, { status: callbackStatus });
    throw new Error('Unexpected URL');
  });
});
afterEach(() => { cleanup(); document.getElementById('facebook-jssdk')?.remove(); vi.unstubAllEnvs(); });
async function openMeta() {
  render(<ConnectWhatsAppPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Connect via Facebook/ }));
  act(() => {
    window.FB = { init: vi.fn(), login: (callback: (response: object) => void) => callback(loginResponse) };
    window.fbAsyncInit();
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect with Facebook' }));
}
it('waits for explicit selection then activates that exact number without forwarding a token', async () => {
  await openMeta();
  const select = await screen.findByLabelText('WhatsApp account');
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/callback'))).toHaveLength(0);
  fireEvent.change(select, { target: { value: 'account-1' } });
  fireEvent.change(screen.getByLabelText('WhatsApp number'), { target: { value: 'phone-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect selected number' }));
  await screen.findByText('WhatsApp Connected!');
  const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/callback'))!;
  expect(JSON.parse(call[1].body)).toEqual({ business_id: 'biz-1', connection_id: 'handle-1', waba_id: 'account-1', phone_number_id: 'phone-1' });
  const discover = fetchMock.mock.calls.find(([url]) => url.endsWith('/discover'))!;
  expect(JSON.parse(discover[1].body)).toEqual({ code: 'meta-code', business_id: 'biz-1' });
});
it('cancellation never calls discovery or activation', async () => {
  loginResponse = {};
  await openMeta();
  await screen.findByText('Cancelled.');
  expect(fetchMock.mock.calls.filter(([url]) => /\/(discover|callback)$/.test(url))).toHaveLength(0);
});
it('provider rejection stays recoverable and does not display success', async () => {
  callbackStatus = 422;
  await openMeta();
  fireEvent.change(await screen.findByLabelText('WhatsApp account'), { target: { value: 'account-1' } });
  fireEvent.change(screen.getByLabelText('WhatsApp number'), { target: { value: 'phone-2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect selected number' }));
  await screen.findByText(/Registration failed.*Reconnect with Meta/);
  expect(screen.queryByText('WhatsApp Connected!')).toBeNull();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Connect with Facebook' }) as HTMLButtonElement).disabled).toBe(false));
});
