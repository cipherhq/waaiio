import { describe,it,expect,vi,beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
const m=vi.hoisted(()=>({auth:vi.fn(),load:vi.fn(),sign:vi.fn(),verify:vi.fn(),deliver:vi.fn(),prior:vi.fn()}));
vi.mock('@/lib/api-auth',()=>({authenticateRequest:m.auth}));
vi.mock('@/lib/parties/reminder-preview',()=>({loadReminderPreview:m.load,signPreview:m.sign,verifyPreview:m.verify}));
vi.mock('@/lib/parties/reminder-delivery',()=>({deliverReminder:m.deliver}));
import {POST} from '@/app/api/parties/[partyId]/reminders/route';
const partyId='00000000-0000-4000-a488-000000000002';
const req=(body:unknown)=>new NextRequest('http://localhost/reminders',{method:'POST',body:JSON.stringify(body)});
const context={params:Promise.resolve({partyId})};
beforeEach(()=>{
 vi.resetAllMocks();const q:any={select:()=>q,eq:()=>q,maybeSingle:m.prior};
 m.auth.mockResolvedValue({user:{id:'owner'},service:{from:()=>q}});m.prior.mockResolvedValue({data:null,error:null});
 m.load.mockResolvedValue({preview:{partyId,purpose:'chase',fingerprint:'current',recipients:[]}});m.sign.mockReturnValue('signed');
 m.verify.mockReturnValue({occurrence:'run',fingerprint:'current'});m.deliver.mockResolvedValue({accepted:0,results:[],state:'finished'});
});
describe('Party reminder HTTP confirmation contract',()=>{
 it('preview is read-only and scheduled preview never returns confirmation token',async()=>{
  const res=await POST(req({op:'preview',purpose:'followup'}),context);expect(res.status).toBe(200);expect((await res.json()).token).toBe(null);expect(m.deliver).not.toHaveBeenCalled();expect(m.sign).not.toHaveBeenCalled();
 });
 it('binds owner from authentication and requires reviewed identity',async()=>{
  await POST(req({op:'confirm',token:'signed',actorId:'forged'}),context);expect(m.verify).toHaveBeenCalledWith('signed',partyId,'owner');expect(m.deliver.mock.calls[0][3]).toBe('owner');
 });
 it('rejects stale content before provider dispatch',async()=>{
  m.verify.mockReturnValue({occurrence:'run',fingerprint:'old'});const res=await POST(req({op:'confirm',token:'signed'}),context);expect(res.status).toBe(409);expect(m.deliver).not.toHaveBeenCalled();
 });
 it('does not disclose another owner party or submit anything',async()=>{
  m.load.mockRejectedValue(new Error('Party unavailable.'));const res=await POST(req({op:'preview',purpose:'chase'}),context);expect(res.status).toBe(409);expect(await res.json()).toEqual({error:'Party unavailable.'});expect(m.deliver).not.toHaveBeenCalled();
 });
});
