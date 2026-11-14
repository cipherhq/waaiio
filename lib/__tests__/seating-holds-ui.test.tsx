// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import InternalHolds from '@/components/dashboard/seating/InternalHolds';
const resources=[{id:'r1',name:'Table A',capacity:10,section:'VIP',is_active:true},{id:'r2',name:'Table B',capacity:8,section:'VIP',is_active:true}];
let requests: Array<{method:string;body:Record<string,unknown>}>;
let failSave: boolean;
const fetchMock=vi.fn(async (_url:unknown,init?:RequestInit)=>{
  if (init?.method) requests.push({method:init.method,body:JSON.parse(String(init.body))});
  if (init?.method==='POST' && failSave) return new Response(JSON.stringify({error:'Unable to save hold. Try again.'}),{status:500});
  return new Response(JSON.stringify({data:[],success:true}),{status:200});
});
beforeEach(()=>{requests=[];failSave=false;vi.stubGlobal('fetch',fetchMock);fetchMock.mockClear();vi.spyOn(window,'confirm').mockReturnValue(true);});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function form(){
  render(<InternalHolds businessId="business" timezone="Africa/Lagos" resources={resources}/>);
  fireEvent.click(screen.getByRole('button',{name:'Add hold'}));
  fireEvent.change(screen.getByLabelText('Start'),{target:{value:'2035-11-02T18:00'}});
  fireEvent.change(screen.getByLabelText('End'),{target:{value:'2035-11-02T20:00'}});
}
describe('internal holds merchant controls',()=>{
  it('sends selected partial seats, preserving request identity for an explicit retry',async()=>{
    await form();fireEvent.click(screen.getByRole('radio',{name:'Table A · VIP'}));
    failSave=true;fireEvent.click(screen.getByRole('button',{name:'Save hold'}));
    await screen.findByRole('alert');const first=requests[0].body;
    expect(first).toMatchObject({resourceIds:['r1'],seats:2,wholeResource:false,label:'VIP'});
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe('2035-11-02T18:00');
    failSave=false;fireEvent.click(screen.getByRole('button',{name:'Save hold'}));
    await screen.findByText('Hold saved.');
    expect(requests[1].body.groupId).toBe(first.groupId);
  });
  it('whole-section selection sends the explicit resource snapshot',async()=>{
    await form();fireEvent.click(screen.getByRole('radio',{name:'Whole table or section'}));
    fireEvent.click(screen.getByRole('checkbox',{name:'Table A · VIP'}));
    fireEvent.click(screen.getByRole('checkbox',{name:'Table B · VIP'}));
    fireEvent.click(screen.getByRole('button',{name:'Save hold'}));
    await screen.findByText('Hold saved.');
    expect(requests[0].body).toMatchObject({resourceIds:['r1','r2'],wholeResource:true,seats:null});
  });
  it('release names the selected hold group and refreshes the list',async()=>{
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({data:[{group_id:'g1',id:'h1',seating_resource_id:'r1',label:'VIP',starts_at:'2035-11-02T18:00:00',ends_at:'2035-11-02T20:00:00',seats:2,whole_resource:false,released_at:null}]})));
    render(<InternalHolds businessId="business" timezone="Africa/Lagos" resources={resources}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Release hold'}));
    await screen.findByText('Hold released.');
    expect(window.confirm).toHaveBeenCalled();
    expect(requests[0]).toEqual({method:'PATCH',body:{businessId:'business',groupId:'g1'}});
    await waitFor(()=>expect(screen.queryByRole('button',{name:'Release hold'})).toBeNull());
  });
});
