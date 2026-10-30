// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import PartiesPage from '@/app/dashboard/parties/page';
import { planSeating, type SeatingSnapshot } from '@/lib/parties/seating-planner';
const mocks = vi.hoisted(() => ({ client: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.client }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id:'business', name:'Business', subscription_tier:'growth', country_code:'NG' }) }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: () => null }));
vi.mock('@/components/ui/PlacesAutocomplete', () => ({ default: () => null }));
let snapshot: SeatingSnapshot;
let calls: Record<string, unknown>[];
let rejectCommit: boolean;
const party = { id:'party', name:'Celebration', date:'2027-01-01', status:'active', allow_plus_ones:true,
  max_plus_ones:3, ask_dietary:false, slug:'celebration', created_at:'2026-10-01' };
beforeEach(() => {
  vi.clearAllMocks(); calls=[]; rejectCommit=false;
  snapshot = { fingerprint:'initial', tables:[{id:'a',name:'Table A',capacity:1}], groups:[],
    guests:[{id:'one',guest_name:'Alex',status:'accepted',plus_ones:0,table_id:null,seating_pinned:false,seating_group_id:null}] };
  mocks.client.mockReturnValue({ from: (table: string) => {
    const data = table==='parties' ? [party] : table==='party_tables' ? snapshot.tables.map(t=>({...t,sort_order:0})) :
      snapshot.guests.map(g=>({...g,guest_phone:'100',tags:[],invite_token:'token',reminder_sent:false,created_at:'2026-10-01',responded_at:null}));
    const q: Record<string, unknown> = {};
    for(const method of ['select','eq','order','is','in','update','insert','delete']) q[method]=()=>q;
    q.then=(resolve: (v: unknown)=>unknown)=>Promise.resolve({data,error:null}).then(resolve);
    return q;
  }});
  mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const input = init?.body ? JSON.parse(String(init.body)) : {op:'snapshot'};
    calls.push(input);
    if(input.op==='preview') return new Response(JSON.stringify({snapshot,plan:planSeating(snapshot,input.seed),seed:input.seed,planHash:'reviewed'}));
    if(input.op==='commit') {
      if(rejectCommit) return new Response(JSON.stringify({error:'Seating changed. Create a new preview.'}),{status:409});
      const p=planSeating(snapshot,input.seed);
      snapshot={...snapshot,fingerprint:'saved',guests:snapshot.guests.map(g=>({...g,table_id:p.assignments.find(a=>a.invite_id===g.id)?.table_id||null}))};
    }
    if(input.op==='save_group') snapshot={...snapshot,groups:[{id:'group',name:input.name,table_ids:input.table_ids}]};
    if(input.op==='membership') snapshot={...snapshot,guests:snapshot.guests.map(g=>g.id===input.invite_id?{...g,seating_group_id:input.group_id}:g)};
    if(input.op==='pin') snapshot={...snapshot,guests:snapshot.guests.map(g=>g.id===input.invite_id?{...g,seating_pinned:input.pinned}:g)};
    return new Response(JSON.stringify({snapshot,success:true}));
  });
  vi.stubGlobal('fetch',mocks.fetch);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function open() {
  render(<PartiesPage />);
  fireEvent.click(await screen.findByText('Celebration'));
  await screen.findByRole('button',{name:'Randomize and preview'});
}
describe('rendered Parties dashboard seating #762',()=>{
  it('shows a preview without committing until explicitly confirmed',async()=>{
    await open();
    fireEvent.click(screen.getByRole('button',{name:'Randomize and preview'}));
    await screen.findByRole('button',{name:'Confirm seating'});
    expect(calls.some(x=>x.op==='commit')).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'Confirm seating'}));
    await waitFor(()=>expect(snapshot.fingerprint).toBe('saved'));
    await waitFor(()=>expect(screen.queryByText('Review seating')).toBeNull());
    expect(snapshot.guests[0].table_id).toBe('a');
    expect(calls.find(x=>x.op==='commit')).toMatchObject({planHash:'reviewed',fingerprint:'initial',acknowledgePartial:false});
  });
  it('requires explicit acknowledgment for visible overflow',async()=>{
    snapshot.guests[0].plus_ones=2;
    await open();
    fireEvent.click(screen.getByRole('button',{name:'Randomize and preview'}));
    const confirm=await screen.findByRole('button',{name:'Confirm seating'}) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(/Not placed by this plan: Alex/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('I acknowledge these guests will remain unassigned.'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(()=>expect(calls.some(x=>x.op==='commit'&&x.acknowledgePartial===true)).toBe(true));
    expect(snapshot.guests[0].table_id).toBeNull();
  });
  it('invalidates review and acknowledgment when configuration is edited',async()=>{
    await open();
    fireEvent.click(screen.getByRole('button',{name:'Randomize and preview'}));
    await screen.findByText('Review seating');
    fireEvent.change(screen.getByLabelText('Group name'),{target:{value:'Family'}});
    expect(screen.queryByRole('button',{name:'Confirm seating'})).toBeNull();
  });
  it('saves explicit allowed tables and displays persisted group readback',async()=>{
    await open();
    fireEvent.change(screen.getByLabelText('Group name'),{target:{value:'Family'}});
    fireEvent.click(screen.getByLabelText('Table A'));
    fireEvent.click(screen.getByRole('button',{name:'Save group'}));
    await screen.findByRole('button',{name:'Edit Family'});
    expect(calls.find(x=>x.op==='save_group')).toMatchObject({name:'Family',table_ids:['a']});
    fireEvent.change(screen.getByLabelText('Seating group for Alex'),{target:{value:'group'}});
    await waitFor(()=>expect(snapshot.guests[0].seating_group_id).toBe('group'));
  });
  it('shows persisted manual pins and explicitly unpins without moving the guest',async()=>{
    snapshot.guests[0].table_id='a';snapshot.guests[0].seating_pinned=true;
    await open();
    fireEvent.click(screen.getByRole('button',{name:'Unpin Alex'}));
    await screen.findByRole('button',{name:'Pin Alex'});
    expect(snapshot.guests[0].table_id).toBe('a');
  });
  it('shows stale-commit errors and requires a fresh preview',async()=>{
    rejectCommit=true;
    await open();
    fireEvent.click(screen.getByRole('button',{name:'Randomize and preview'}));
    fireEvent.click(await screen.findByRole('button',{name:'Confirm seating'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Seating changed. Create a new preview.');
    expect(screen.queryByRole('button',{name:'Confirm seating'})).toBeNull();
    expect(snapshot.guests[0].table_id).toBeNull();
  });
});
