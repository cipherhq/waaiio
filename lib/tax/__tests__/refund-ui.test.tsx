// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({load:vi.fn(),fetch:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({})}));
vi.mock('@/lib/tax/refund-ui',async()=>({...await vi.importActual('@/lib/tax/refund-ui'),loadTaxRefundLines:h.load}));
import {RefundModal} from '@/components/dashboard/RefundModal';
import {refundLineSelection} from '../refund-ui';
const props={open:true,onClose:vi.fn(),paymentId:'payment',paymentAmount:12,existingRefundAmount:0,currency:'USD',businessId:'business',isDirectSplit:false,countryCode:'US' as const,onSuccess:vi.fn()};
beforeEach(()=>{vi.clearAllMocks();h.load.mockResolvedValue([{id:'a',label:'Booking',remainingMinor:1200}]);h.fetch.mockResolvedValue({ok:true,json:async()=>({success:true})});vi.stubGlobal('fetch',h.fetch);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('merchant refund item selection',()=>{
 it('sends selected tax-inclusive item amounts with a durable request ID',async()=>{
  render(<RefundModal {...props}/>);await screen.findByText('Choose item amounts');
  fireEvent.click(screen.getByLabelText('Choose item amounts'));
  fireEvent.change(screen.getByLabelText('Refund for Booking'),{target:{value:'6.25'}});
  fireEvent.click(screen.getByText('Confirm Refund'));
  await waitFor(()=>expect(h.fetch).toHaveBeenCalledTimes(1));
  const body=JSON.parse(h.fetch.mock.calls[0][1].body);
  expect(body).toMatchObject({amount:6.25,taxSelection:{mode:'lines',lines:[{id:'a',grossAmount:625}]}});
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
 });
 it('records a zero-value item quantity without a monetary refund',async()=>{
  h.load.mockResolvedValueOnce([{id:'free',label:'Sample',remainingMinor:0,zeroValue:true,quantity:1}]);
  render(<RefundModal {...props}/>);await screen.findByText('Record a no-value item return');
  fireEvent.click(screen.getByLabelText('Record a no-value item return'));
  fireEvent.change(screen.getByLabelText('Return quantity for Sample'),{target:{value:'1'}});
  fireEvent.click(screen.getByText('Confirm Refund'));await waitFor(()=>expect(h.fetch).toHaveBeenCalledTimes(1));
  expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toMatchObject({amount:0,taxSelection:{mode:'items',items:[{id:'free',quantity:1}]}});
 });
 it('supports a full remaining payment without inventing item quantities',async()=>{
  render(<RefundModal {...props}/>);await screen.findByText('Choose item amounts');
  fireEvent.click(screen.getByText('Confirm Refund'));await waitFor(()=>expect(h.fetch).toHaveBeenCalled());
  expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toEqual({paymentId:'payment',businessId:'business',amount:12});
 });
 it('keeps legacy amount-only refunds and refuses unreadable allocations',async()=>{
  h.load.mockResolvedValueOnce(null);const view=render(<RefundModal {...props}/>);
  await waitFor(()=>expect(screen.queryByText('Loading refundable items…')).toBeNull());
  fireEvent.click(screen.getByText('Half'));fireEvent.click(screen.getByText('Confirm Refund'));
  await waitFor(()=>expect(h.fetch).toHaveBeenCalledTimes(1));expect(JSON.parse(h.fetch.mock.calls[0][1].body).amount).toBe(6);
  view.unmount();h.load.mockRejectedValueOnce(new Error('read failure'));render(<RefundModal {...props}/>);
  await screen.findByRole('alert');expect((screen.getByText('Confirm Refund') as HTMLButtonElement).disabled).toBe(true);
 });
 it('caps per-item amounts and rejects empty or fractional-minor selections',()=>{
  const lines=[{id:'a',label:'Item',remainingMinor:100}];
  for(const amount of ['1.01','0.001','NaN','-1',''])expect(()=>refundLineSelection(lines,{a:amount})).toThrow();
 });
});
