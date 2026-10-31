// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const h=vi.hoisted(()=>({capabilities:['table_reservation'],updates:[] as any[],filters:[] as any[]}));
vi.mock('@/components/dashboard/DashboardProvider',()=>({useBusiness:()=>({id:'biz',country_code:'US',capabilities:h.capabilities})}));
vi.mock('@/components/dashboard/PageHelp',()=>({PageHelp:()=>null}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({from:()=>{let write=false;const q:any={select:()=>q,order:()=>q,eq:(...a:any[])=>{h.filters.push(a);return q;},in:(...a:any[])=>{h.filters.push(a);return q;},update:(p:any)=>{write=true;h.updates.push(p);return q;},then:(resolve:any)=>Promise.resolve({data:write?[{id:'1'},{id:'2'},{id:'3'}]:['1','2','3'].map(id=>({id,name:`VIP ${id}`,resource_type:'table',capacity:4,min_party_size:1,reservation_duration_minutes:90,is_active:true,deposit_amount:0}))}).then(resolve)};return q;}})}));
import SeatingPage from '@/app/dashboard/seating/page';
beforeEach(()=>{h.capabilities=['table_reservation'];h.updates=[];h.filters=[];vi.spyOn(window,'confirm').mockReturnValue(true);});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('blocks three selected VIP tables in one business-scoped update',async()=>{render(<SeatingPage/>);for(const id of ['1','2','3'])fireEvent.click(await screen.findByLabelText(`Select VIP ${id}`));fireEvent.click(screen.getByText('Block selected'));await waitFor(()=>expect(h.updates).toEqual([{is_active:false}]));expect(h.filters).toContainEqual(['business_id','biz']);expect(h.filters).toContainEqual(['id',['1','2','3']]);expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('until you unblock'));});
it('free business sees Pro guidance instead of seating mutation controls',async()=>{h.capabilities=[];render(<SeatingPage/>);expect(await screen.findByText(/Table Reservations is a Pro feature/)).toBeTruthy();expect(screen.queryByText('Block selected')).toBeNull();expect(h.updates).toHaveLength(0);});
it('cancelled bulk selection does not write',async()=>{vi.mocked(window.confirm).mockReturnValue(false);render(<SeatingPage/>);fireEvent.click(await screen.findByLabelText('Select VIP 1'));fireEvent.click(screen.getByText('Block selected'));expect(h.updates).toHaveLength(0);});
