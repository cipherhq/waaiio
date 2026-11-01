// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextRequest } from 'next/server';
import DirectoryClient from '@/app/(marketing)/directory/DirectoryClient';

const state = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]> }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: (table: string) => {
  const chain: Record<string, unknown> = {};
  for (const name of ['select','eq','in','order','gte']) chain[name] = () => chain;
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: state.rows[table] || [], error: null }));
  return chain;
} }) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'test' }));
vi.mock('@/lib/marketplace/search', () => ({ loadDirectoryHiddenIds: async () => [], searchMarketplace: async () => ({ ok: true, results: [{businessId:'business-a',name:'Ayo fixture',countryCode:'GB',botCode:'AYO',category:'salon'}] }) }));
const { GET } = await import('@/app/api/directory/route');
beforeEach(() => {
  cleanup(); vi.unstubAllGlobals();
  state.rows = {
    businesses: [{id:'business-a',wa_method:'shared',assigned_channel_id:'stage-channel'}],
    whatsapp_channels: [{id:'stage-channel',channel_type:'shared',phone_number:'12404712139',is_active:true,connection_status:'active'}],
  };
});
async function load() { return (await GET(new NextRequest('https://example.test/api/directory'))).json(); }
async function show() {
  const data = await load();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok:true,json:async()=>data}));
  render(<DirectoryClient />);
  await screen.findByText('Ayo fixture');
  return data;
}
describe('directory assigned-channel links', () => {
  it('renders the assigned staging shared number with business code for a UK merchant', async () => {
    const data = await show();
    expect(data.businesses[0]).toMatchObject({wa_method:'shared',wa_phone:'12404712139'});
    expect(screen.getByRole('link',{name:/WhatsApp/}).getAttribute('href')).toBe('https://wa.me/12404712139?text=AYO');
    expect(document.querySelector('a[href*="12029226251"]')).toBeNull();
  });
  it('renders an owned dedicated number without a shared business code', async () => {
    state.rows.businesses = [{id:'business-a',wa_method:'dedicated',whatsapp_channel_id:'dedicated'}];
    state.rows.whatsapp_channels = [{id:'dedicated',business_id:'business-a',channel_type:'dedicated',phone_number:'447700900123',is_active:true,connection_status:'active'}];
    await show(); expect(screen.getByRole('link',{name:/WhatsApp/}).getAttribute('href')).toBe('https://wa.me/447700900123?text=Hi');
  });
  it.each(['inactive','unassigned','wrong-owner'])('does not invent a fallback number when %s', async (kind) => {
    if(kind==='inactive') state.rows.whatsapp_channels = [{id:'stage-channel',channel_type:'shared',phone_number:'12404712139',is_active:false,connection_status:'active'}];
    if(kind==='unassigned') state.rows.businesses = [{id:'business-a',wa_method:'shared'}];
    if(kind==='wrong-owner') state.rows.whatsapp_channels = [{id:'stage-channel',channel_type:'dedicated',business_id:'other',phone_number:'12404712139',is_active:true,connection_status:'active'}];
    await show(); await waitFor(()=>expect(screen.queryByRole('link',{name:/WhatsApp/})).toBeNull());
    expect(screen.getByText('WhatsApp connection unavailable')).toBeTruthy();
  });
});
