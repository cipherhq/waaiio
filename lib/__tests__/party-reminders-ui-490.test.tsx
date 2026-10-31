// @vitest-environment jsdom
import React from 'react';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import Preview from '@/app/dashboard/parties/components/PartyReminderPreview';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('mounted Party reminder confirmation',()=>{
 it('shows exact content before confirmation and distinguishes unknown from accepted',async()=>{
  const fetcher=vi.fn().mockImplementation(async (_url:string,init:RequestInit)=>{
   const body=JSON.parse(String(init.body));return new Response(JSON.stringify(body.op==='preview'?{token:'signed',preview:{purpose:'chase',notice:'Acceptance is not delivery.',recipients:[{id:'invite',name:'Alex',status:'maybe',eligible:true,variants:[{channel:'whatsapp_text',available:true,reason:'Window open',text:'Reminder\nTable: A'}]}]}}:{state:'finished',accepted:0,results:[{inviteId:'invite',channel:'whatsapp_text',state:'unknown'}]}));
  });vi.stubGlobal('fetch',fetcher);
  render(<Preview partyId="party" onSaved={()=>{}}/>);fireEvent.click(screen.getByText('Preview pending / maybe reminder'));
  await screen.findByText('Reminder Table: A',{exact:false});expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('Confirm this reminder'));await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({op:'confirm',token:'signed'});
  await screen.findByText(/Some outcomes remain unknown/);
 });
});
