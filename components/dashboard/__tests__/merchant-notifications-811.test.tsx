// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import { MerchantNotificationRecipients } from '../MerchantNotificationRecipients';
import Confirm from '@/app/notifications/confirm/page';
import { FeaturesTab } from '@/app/dashboard/settings/tabs/FeaturesTab';
import type { SettingsTabProps } from '@/app/dashboard/settings/tabs/types';
import { StepSuccess } from '@/app/get-started/steps/StepSuccess';

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({data:null,error:null}) }) }) }) }) }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: {value: string}) => <svg data-testid="qr" data-value={value} />, QRCodeCanvas: () => <canvas /> }));
const recipient = { id:'r1', business_id:'business-a', label:'Sales manager', channel:'whatsapp', address:'+2348012345678', events:['sale','payment'], enabled:true, verified_at:null, revoked_at:null };
const payload = (recipients: unknown[] = [recipient], enabled = true) => ({ recipients, enabled, readiness:{whatsapp:true,email:true} });
const response = (data: unknown, ok = true) => Promise.resolve({ok,json:async()=>data});
const fetcher = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetcher); fetcher.mockReset(); window.history.replaceState(null,'','/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('merchant recipient management', () => {
  it('keeps WhatsApp pending after link generation and gives the same link to QR', async () => {
    const url = 'https://wa.me/15551234567?text=WAAIIO%20ALERTS%20' + 'x'.repeat(43);
    fetcher.mockImplementation((_url, init) => response(init.method === 'POST' ? {url,expires_at:'2099-01-01T00:00:00Z'} : payload()));
    render(<MerchantNotificationRecipients businessId="business-a" />);
    fireEvent.click(await screen.findByRole('button',{name:'Create confirmation link'}));
    const link = await screen.findByRole('link',{name:'Open WhatsApp to confirm'});
    expect(link.getAttribute('href')).toBe(url);
    expect(screen.getByTestId('qr').getAttribute('data-value')).toBe(url);
    expect(screen.getByText('Awaiting confirmation')).toBeTruthy();
    expect(screen.queryByText('Confirmed')).toBeNull();
    expect(screen.getByText(/Either option works/)).toBeTruthy();
    expect(fetcher.mock.calls[1][1].body).toBe(JSON.stringify({business_id:'business-a',id:'r1'}));
  });
  it('renders confirmed, disabled, removed statuses and saves per-recipient event preferences', async () => {
    fetcher.mockImplementation(() => response(payload([{...recipient,verified_at:'2026-01-01'}, {...recipient,id:'r2',label:'Owner',enabled:false}, {...recipient,id:'r3',label:'Old team',revoked_at:'2026-01-01'}])));
    render(<MerchantNotificationRecipients businessId="business-a" />);
    expect(await screen.findByText('Confirmed')).toBeTruthy();
    expect(screen.getByText('Disabled')).toBeTruthy(); expect(screen.getByText('Removed')).toBeTruthy();
    const manager = within(screen.getByRole('article',{name:'Sales manager whatsapp'}));
    fireEvent.click(manager.getByLabelText('Appointments'));
    await waitFor(()=>expect(fetcher.mock.calls.some(([,init])=>init.method==='PATCH' && JSON.parse(init.body).events.includes('appointment'))).toBe(true));
    expect(manager.queryByRole('button',{name:'Create confirmation link'})).toBeNull();
  });
  it('adds a second destination without activating it and reports invitation failures', async () => {
    fetcher.mockImplementation((_url,init)=>response(init.method === 'POST' ? {recipient} : payload()));
    render(<MerchantNotificationRecipients businessId="business-a" />);
    await screen.findByText('Awaiting confirmation');
    fireEvent.change(screen.getByLabelText('Name or team'),{target:{value:'Accounts'}});
    fireEvent.change(screen.getByLabelText('Send alerts by'),{target:{value:'email'}});
    fireEvent.change(screen.getByLabelText('Email address'),{target:{value:'accounts@example.com'}});
    fireEvent.click(screen.getByRole('button',{name:'Add recipient'}));
    await screen.findByText(/Recipient added/);
    expect(fetcher.mock.calls.some(([,init])=>init.method==='POST' && JSON.parse(init.body).address==='accounts@example.com')).toBe(true);
    fetcher.mockImplementation(()=>response({error:'Email service unavailable'},false));
    fireEvent.click(screen.getByRole('button',{name:'Create confirmation link'}));
    expect((await screen.findByRole('alert')).textContent).toBe('Email service unavailable');
    expect(screen.queryByRole('link',{name:'Open WhatsApp to confirm'})).toBeNull();
  });
  it('rejects unsafe invitation links and never reports confirmation', async () => {
    fetcher.mockImplementation((_url,init)=>response(init.method === 'POST' ? {url:'https://evil.example',expires_at:'2099-01-01'} : payload()));
    render(<MerchantNotificationRecipients businessId="business-a" />);
    fireEvent.click(await screen.findByRole('button',{name:'Create confirmation link'}));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be created/);
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('clears old tenant state and ignores late responses on business switch', async () => {
    let resolveOld!: (value:unknown)=>void;
    fetcher.mockImplementation((url)=>url.includes('business-a') ? new Promise(resolve=>{resolveOld=resolve;}) : response(payload([{...recipient,business_id:'business-b',label:'B owner',address:'+15550000000'}])));
    const view = render(<MerchantNotificationRecipients businessId="business-a" />);
    view.rerender(<MerchantNotificationRecipients businessId="business-b" />);
    await screen.findByText('B owner');
    await act(async()=>{resolveOld({ok:true,json:async()=>payload()});});
    expect(screen.queryByText('Sales manager')).toBeNull();
    expect(screen.queryByText(/2348012345678/)).toBeNull();
  });
  it('rollout off prevents enrollment and adding but permits removal', async () => {
    fetcher.mockImplementation(()=>response(payload([recipient],false)));
    render(<MerchantNotificationRecipients businessId="business-a" />);
    const invite = await screen.findByRole('button',{name:'Create confirmation link'}) as HTMLButtonElement;
    expect(invite.disabled).toBe(true);
    expect((screen.getByRole('button',{name:'Remove'}) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('Name or team') as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);
  });
  it('settings retains legacy preferences alongside recipient setup', async () => {
    fetcher.mockImplementation(()=>response(payload()));
    const props = {business:{id:'business-a',metadata:{},subscription_tier:'free'},capabilities:[],country:'NG',curr:'NGN',saving:false,setSaving:vi.fn(),saved:false,setSaved:vi.fn(),openSections:['notifications'],toggleSection:vi.fn()} as unknown as SettingsTabProps;
    render(<FeaturesTab {...props} />);
    await screen.findByText('Awaiting confirmation');
    expect(screen.getByText('Email notifications')).toBeTruthy();
    expect(screen.getByRole('button',{name:'Save Preferences'})).toBeTruthy();
    expect(screen.getByRole('region',{name:'Team notification recipients'})).toBeTruthy();
  });
  it('onboarding renders setup for the created business without blocking dashboard access', async () => {
    fetcher.mockImplementation(()=>response(payload([],false)));
    render(<StepSuccess loading={false} successData={{business_id:'business-a',bot_code:'SHOP'}} waMethod="shared" waLink="https://www.waaiio.com/m/business-a" category="shop" selectedCapabilities={['ordering']} error="" setStep={vi.fn()} setError={vi.fn()} fbConnectionData={null} />);
    expect(await screen.findByRole('region',{name:'Team notification recipients'})).toBeTruthy();
    expect(screen.getByRole('link',{name:/Go to Dashboard/i})).toBeTruthy();
    expect(fetcher.mock.calls[0][0]).toContain('business_id=business-a');
  });
});

describe('email confirmation consent', () => {
  it('clears fragment and makes no request until explicit consent, then posts accept true', async () => {
    const token='x'.repeat(43); window.history.replaceState(null,'','/notifications/confirm#token='+token);
    fetcher.mockImplementation(()=>response({verified:true}));
    render(<Confirm />);
    expect(window.location.hash).toBe(''); expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'I agree — confirm email alerts'}));
    await screen.findByText('Email alerts confirmed');
    expect(fetcher.mock.calls[0][0]).toBe('/api/merchant-notifications/confirm');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({token,accept:true});
    expect(document.body.textContent).not.toContain(token);
  });
  it('preserves same-origin deployment access on explicit confirmation without bypassing the token', async () => {
    const token = 'y'.repeat(43);
    window.history.replaceState(null, '', '/notifications/confirm#token=' + token);
    // Model the protection boundary: dropping credentials prevents the API from being reached.
    fetcher.mockImplementation((url, init) => {
      expect(url).toBe('/api/merchant-notifications/confirm');
      if (init.credentials !== 'same-origin') return response({error: 'Deployment authentication required'}, false);
      expect(init.method).toBe('POST');
      expect(init.cache).toBe('no-store');
      expect(JSON.parse(init.body)).toEqual({token, accept: true});
      return response({verified: true});
    });
    render(<Confirm />);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: 'I agree — confirm email alerts'}));
    await screen.findByText('Email alerts confirmed');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].credentials).toBe('same-origin');
    expect(window.location.hash).toBe('');
  });
  it('shows invalid invitation without a request', () => {
    render(<Confirm />); expect(screen.getByRole('alert').textContent).toMatch(/missing or invalid/); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not claim confirmation after expiry failure', async () => {
    window.history.replaceState(null,'','/notifications/confirm#token='+'x'.repeat(43));
    fetcher.mockImplementation(()=>response({error:'Invitation expired'},false));
    render(<Confirm />); fireEvent.click(screen.getByRole('button',{name:'I agree — confirm email alerts'}));
    expect((await screen.findByRole('alert')).textContent).toBe('Invitation expired'); expect(screen.queryByText('Email alerts confirmed')).toBeNull();
  });
});
