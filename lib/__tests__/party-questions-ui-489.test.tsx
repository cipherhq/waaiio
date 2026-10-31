// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
vi.mock('next/navigation', () => ({ useParams: () => ({token:'party-token'}) }));
import RSVPPage from '@/app/rsvp/[token]/page';
import Editor from '@/app/dashboard/parties/components/PartyQuestionsEditor';
const questions=[{id:'access',label:'Need access?',type:'yes_no',required:true}];
const invite={id:'invite',status:'maybe',plus_ones:0,dietary_notes:null,custom_answers:{},guest_name:'Guest',parties:{id:'party',name:'Celebration',date:'2027-01-01',time:null,venue:null,allow_plus_ones:false,ask_dietary:false,question_definitions:questions,question_revision:1,businesses:{name:'Host',slug:'host'}},events:null};
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(()=>{fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('mounted Party Questions',()=>{
  it('blocks acceptance without required answer, retains false after failed save',async()=>{
    fetcher.mockImplementation(async (_url:string,init?:RequestInit)=>new Response(JSON.stringify(init?{error:'Capacity changed'}:{invite}),{status:init?409:200}));
    render(<RSVPPage/>); fireEvent.click(await screen.findByText('Change response'));
    fireEvent.click(screen.getByRole('button',{name:'Yes!'})); fireEvent.click(screen.getByText('Confirm RSVP'));
    expect(await screen.findByRole('alert')).toBeTruthy(); expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Need access? *'),{target:{value:'false'}}); fireEvent.click(screen.getByText('Confirm RSVP'));
    await screen.findByText('Capacity changed'); expect((screen.getByLabelText('Need access? *') as HTMLSelectElement).value).toBe('false');
    expect(JSON.parse(fetcher.mock.calls[1][1].body).answers).toEqual({access:false});
  });
  it('allows Maybe without required answers and uses saved response',async()=>{
    fetcher.mockImplementation(async (_url:string,init?:RequestInit)=>new Response(JSON.stringify(init?{success:true,saved:{status:'maybe',plus_ones:0}}:{invite})));
    render(<RSVPPage/>); fireEvent.click(await screen.findByText('Change response')); fireEvent.click(screen.getByText('Confirm RSVP'));
    await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2)); expect(JSON.parse(fetcher.mock.calls[1][1].body).status).toBe('maybe');
  });
  it('organizer saves stable question IDs and reads back the canonical revision',async()=>{
    fetcher.mockImplementation(async (_url:string,init?:RequestInit)=>new Response(JSON.stringify({questions:init?JSON.parse(String(init.body)).questions:questions,revision:init?2:1,responses:[]})));
    render(<Editor partyId="party"/>); fireEvent.change(await screen.findByLabelText('Question 1'),{target:{value:'Access required?'}}); fireEvent.click(screen.getByText('Save questions'));
    await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2)); expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({revision:1,questions:[{...questions[0],label:'Access required?'}]});
  });
});
