// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react';
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
type Gate = { promise: Promise<void>; release: () => void };
let gates: Gate[];
let parentCountGate: Gate | null;
let nextSnapshotGate: Gate | null;
let parentCountReads: number;
function deferredGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  const gate = { promise, release };
  gates.push(gate);
  return gate;
}
const party = { id:'party', name:'Celebration', date:'2027-01-01', status:'active', allow_plus_ones:true,
  max_plus_ones:3, ask_dietary:false, slug:'celebration', created_at:'2026-10-01' };
beforeEach(() => {
  vi.clearAllMocks(); calls=[]; rejectCommit=false;
  gates=[]; parentCountGate=null; nextSnapshotGate=null; parentCountReads=0;
  snapshot = { fingerprint:'initial', tables:[{id:'a',name:'Table A',capacity:1}], groups:[],
    guests:[{id:'one',guest_name:'Alex',status:'accepted',plus_ones:0,table_id:null,seating_pinned:false,seating_group_id:null}] };
  mocks.client.mockReturnValue({ from: (table: string) => {
    let columns = '';
    const filters: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    q.select=(value: string)=>{columns=value;return q;};
    q.eq=(key: string,value: unknown)=>{filters[key]=value;return q;};
    for(const method of ['order','is','in','update','insert','delete']) q[method]=()=>q;
    q.then=(resolve: (v: unknown)=>unknown, reject?: (reason: unknown)=>unknown)=>{
      const read = async () => {
        if(table==='event_invites' && columns==='plus_ones') {
          parentCountReads++;
          if(parentCountGate) await parentCountGate.promise;
          return {data:snapshot.guests.filter(g=>g.table_id===filters.table_id)
            .map(g=>({plus_ones:g.plus_ones})),error:null};
        }
        const data = table==='parties' ? [party] : table==='party_tables' ? snapshot.tables.map(t=>({...t,sort_order:0})) :
          snapshot.guests.map(g=>({...g,guest_phone:'100',tags:[],invite_token:'token',reminder_sent:false,created_at:'2026-10-01',responded_at:null}));
        return {data,error:null};
      };
      return read().then(resolve,reject);
    };
    return q;
  }});
  mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (_url.endsWith('/questions')) return new Response(JSON.stringify({questions:[],revision:0,responses:[]}));
    const input = init?.body ? JSON.parse(String(init.body)) : {op:'snapshot'};
    calls.push(input);
    if(input.op==='snapshot' && nextSnapshotGate) {
      const gate=nextSnapshotGate;nextSnapshotGate=null;
      await gate.promise;
    }
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
afterEach(async()=>{
  cleanup();
  await act(async()=>{for(const gate of gates) gate.release();});
  vi.unstubAllGlobals();
});
async function navigateToParty() {
  render(<PartiesPage />);
  fireEvent.click(await screen.findByText('Celebration'));
}
async function waitForLoadedParty() {
  // Parent list and table counts must render before waiting for the current editor.
  await waitFor(()=>{
    const guests=within(screen.getByRole('table'));
    for(const guest of snapshot.guests) {
      expect(guests.getByRole('cell',{name:guest.guest_name!})).toBeTruthy();
    }
    for(const table of snapshot.tables) {
      const seated=snapshot.guests.filter(g=>g.table_id===table.id)
        .reduce((total,g)=>total+1+g.plus_ones,0);
      expect(screen.getByText(`${seated} / ${table.capacity} seats`,{exact:true})).toBeTruthy();
    }
  });
  await waitFor(()=>{
    const editor=within(screen.getByRole('region',{name:'Seating plan'}));
    expect(editor.queryByRole('status')).toBeNull();
    for(const guest of snapshot.guests) {
      expect(editor.getByLabelText('Seating group for '+guest.guest_name)).toBeTruthy();
    }
    const randomize=editor.getByRole('button',{name:'Randomize and preview'}) as HTMLButtonElement;
    expect(randomize.disabled).toBe(false);
    expect(randomize.closest('fieldset')?.disabled).toBe(false);
  });
}
async function open() {
  await navigateToParty();
  await waitForLoadedParty();
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
  it('displays saved table, group and pin values after commit and full remount',async()=>{
    snapshot.tables[0].capacity=2;
    snapshot.groups=[{id:'family',name:'Family',table_ids:['a']}];
    snapshot.guests[0].seating_group_id='family';
    snapshot.guests.push({id:'two',guest_name:'Jordan',status:'accepted',plus_ones:0,
      table_id:'a',seating_pinned:true,seating_group_id:'family'});
    await open();
    fireEvent.click(screen.getByRole('button',{name:'Randomize and preview'}));
    fireEvent.click(await screen.findByRole('button',{name:'Confirm seating'}));
    await waitFor(()=>expect(snapshot.fingerprint).toBe('saved'));
    await waitFor(()=>expect(screen.queryByText('Review seating')).toBeNull());
    cleanup();
    const readsBeforeRemount=calls.filter(c=>c.op==='snapshot').length;
    await open();
    await waitFor(()=>expect(calls.filter(c=>c.op==='snapshot').length).toBeGreaterThan(readsBeforeRemount));
    expect(await screen.findByText(/^Alex · 1 seat · Table A$/)).toBeTruthy();
    expect(await screen.findByText(/^Jordan · 1 seat · Table A · Pinned$/)).toBeTruthy();
    expect((screen.getByLabelText('Seating group for Alex') as HTMLSelectElement).value).toBe('family');
    expect((screen.getByLabelText('Seating group for Jordan') as HTMLSelectElement).value).toBe('family');
    expect(screen.getByRole('button',{name:'Pin Alex'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'Unpin Jordan'})).toBeTruthy();
    expect(screen.queryByText('Review seating')).toBeNull();
  });

  it('invalidates an early preview when deferred parent counts arrive, then previews current data',async()=>{
    parentCountGate=deferredGate();
    await navigateToParty();
    await waitFor(()=>expect(parentCountReads).toBe(1));
    await screen.findByRole('cell',{name:'Alex'});
    const editor=within(screen.getByRole('region',{name:'Seating plan'}));
    fireEvent.click(await editor.findByRole('button',{name:'Randomize and preview'}));
    await editor.findByRole('button',{name:'Confirm seating'});
    expect(screen.queryByText('0 / 1 seats',{exact:true})).toBeNull();
    expect(calls.some(x=>x.op==='commit')).toBe(false);

    const currentSnapshot=deferredGate();
    nextSnapshotGate=currentSnapshot;
    await act(async()=>{parentCountGate!.release();});
    expect(await editor.findByRole('status')).toHaveProperty('textContent','Loading seating…');
    expect(editor.queryByRole('button',{name:'Confirm seating'})).toBeNull();
    expect(calls.some(x=>x.op==='commit')).toBe(false);

    await act(async()=>{currentSnapshot.release();});
    await waitForLoadedParty();
    fireEvent.click(editor.getByRole('button',{name:'Randomize and preview'}));
    await editor.findByRole('button',{name:'Confirm seating'});
    expect(calls.some(x=>x.op==='commit')).toBe(false);
    fireEvent.click(editor.getByRole('button',{name:'Confirm seating'}));
    await waitFor(()=>expect(snapshot.fingerprint).toBe('saved'));
    expect(snapshot.guests[0].table_id).toBe('a');
    expect(calls.filter(x=>x.op==='commit')).toHaveLength(1);
  });

});
