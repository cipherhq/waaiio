// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    request.mockResolvedValueOnce(Response.json({enabled:true,published:false}));
    render(<NativeFormPanel businessId="business" formId="form" />);
    request.mockResolvedValueOnce(Response.json({published:true})).mockResolvedValueOnce(Response.json({enabled:true,published:true,token:'abcdefgh'}));
    fireEvent.click(await screen.findByRole('button',{name:'Publish in WhatsApp'}));
    expect(await screen.findByRole('button',{name:'Copy WhatsApp form link'})).toBeTruthy();
    request.mockResolvedValueOnce(Response.json({sent:true}));
    fireEvent.change(screen.getByLabelText('Customer WhatsApp number'),{target:{value:'+12025550123'}});
    fireEvent.click(screen.getByRole('button',{name:'Send form in WhatsApp'}));
    expect(await screen.findByText('Accepted by WhatsApp. Delivery is not yet confirmed.')).toBeTruthy();
    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({businessId:'business',formId:'form'});
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
