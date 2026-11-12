// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NativeFormPanel } from '@/components/dashboard/forms/NativeFormPanel';
import { NativeFormEmailComposer } from '@/components/dashboard/forms/NativeFormEmailComposer';
const request = vi.fn();
beforeEach(() => { request.mockReset(); vi.stubGlobal('fetch',request); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('#591 merchant controls', () => {
  it('does not offer provider publication when disabled', async () => {
    request.mockResolvedValue(Response.json({enabled:false,published:false}));
    render(<NativeFormPanel businessId="business" formId="form" />);
    expect(await screen.findByText('Native forms are awaiting activation.')).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Publish in WhatsApp'})).toBeNull();
  });
  it('publishes explicitly, refreshes status and shows provider acceptance separately from delivery', async () => {
    let published = false;
    request.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/forms/recipients?')) return Response.json({ contacts: [], truncated: false });
      if (url.endsWith('/publish')) { published = true; return Response.json({ published }); }
      if (url.endsWith('/send')) return Response.json({ sent: true });
      return Response.json({ enabled: true, published, token: published ? 'abcdefgh' : null });
    });
    render(<NativeFormPanel businessId="business" formId="form" />);
    fireEvent.click(await screen.findByRole('button',{name:'Publish in WhatsApp'}));
    expect(await screen.findByRole('button',{name:'Copy WhatsApp form link'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Customer WhatsApp number'),{target:{value:'+12025550123'}});
    fireEvent.click(screen.getByRole('button',{name:'Send form in WhatsApp'}));
    expect(await screen.findByText('Accepted by WhatsApp. Delivery is not yet confirmed.')).toBeTruthy();
    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({businessId:'business',formId:'form'});
  });

  it('selects an opted-in number, reports truncation, and still respects the server chat-window denial', async () => {
    request.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/forms/recipients?')) return Response.json({ contacts: [{ phone: '+12025550123', name: null }], truncated: true });
      if (url.endsWith('/send')) return Response.json({ reason: 'customer_must_open_chat' }, { status: 409 });
      return Response.json({ enabled: true, published: true, token: 'abcdefgh' });
    });
    render(<NativeFormPanel businessId="business" formId="form" />);
    await screen.findByRole('option', { name: '+12025550123' });
    expect(screen.getByText(/This list is incomplete/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Choose an opted-in customer'), { target: { value: '+12025550123' } });
    expect((screen.getByLabelText('Customer WhatsApp number') as HTMLInputElement).value).toBe('+12025550123');
    expect(request.mock.calls.some(([url]) => url.endsWith('/send'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Send form in WhatsApp' }));
    expect(await screen.findByText('Ask this customer to open your WhatsApp form link first.')).toBeTruthy();
    const sent = request.mock.calls.find(([url]) => url.endsWith('/send'))!;
    expect(JSON.parse(sent[1].body)).toEqual({ businessId: 'business', formId: 'form', recipientPhone: '+12025550123' });
  });

  it('keeps manual entry available if the consent list is unavailable', async () => {
    request.mockImplementation(async (url: string) => url.startsWith('/api/forms/recipients?')
      ? Response.json({}, { status: 503 }) : Response.json({ enabled: true, published: true }));
    render(<NativeFormPanel businessId="business" formId="form" />);
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Choose an opted-in customer') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Customer WhatsApp number'), { target: { value: '+12025550123' } });
    expect((screen.getByRole('button', { name: 'Send form in WhatsApp' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('clears the phone and ignores contacts from an old business request', async () => {
    let resolveOld!: (response: Response) => void;
    request.mockImplementation(async (url: string) => {
      if (url === '/api/forms/recipients?businessId=business-a') return new Promise<Response>(resolve => { resolveOld = resolve; });
      if (url.startsWith('/api/forms/recipients?')) return Response.json({ contacts: [], truncated: false });
      return Response.json({ enabled: true, published: true });
    });
    const view = render(<NativeFormPanel businessId="business-a" formId="form-a" />);
    await screen.findByRole('option', { name: 'Loading opted-in contacts…' });
    fireEvent.change(screen.getByLabelText('Customer WhatsApp number'), { target: { value: '+12025550123' } });
    view.rerender(<NativeFormPanel businessId="business-b" formId="form-b" />);
    await act(async () => { resolveOld(Response.json({ contacts: [{ phone: '+12025550123', name: null }] })); });
    await screen.findByText('No opted-in contacts yet.');
    expect(screen.queryByRole('option', { name: '+12025550123' })).toBeNull();
    expect((screen.getByLabelText('Customer WhatsApp number') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Send form in WhatsApp' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('email is explicit and reuses the batch identity when checking the result', async () => {
    request.mockResolvedValue(Response.json({accepted:1,skipped:0,unknown:0}));
    render(<NativeFormEmailComposer businessId="business" responses={[{id:'response',customer_email:'ada@example.test',submission_source:'native'}]} />);
    expect(request).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button',{name:'Email form respondents'}));
    expect((screen.getByRole('button',{name:'Send email updates'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.change(screen.getByRole('textbox'),{target:{value:'Program update'}});
    fireEvent.click(screen.getByRole('button',{name:'Send email updates'}));
    await screen.findByText(/1 accepted by the email provider/);
    fireEvent.click(screen.getByRole('button',{name:'Check / retry this batch'}));
    await waitFor(()=>expect(request).toHaveBeenCalledTimes(2));
    const first = JSON.parse(request.mock.calls[0][1].body), second = JSON.parse(request.mock.calls[1][1].body);
    expect(first).toEqual(second); expect(first).toMatchObject({business_id:'business',channel:'email',response_ids:['response']});
  });
});
