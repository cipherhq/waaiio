import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const h = vi.hoisted(() => ({ user: null as any, results: [] as any[], queries: [] as any[], exists: false, unconfirmed: false, delivery: true, linkError: false }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }));
vi.mock('@/lib/onboarding/auth-user', () => ({ findAuthUser: async () => h.exists ? { email_confirmed_at: h.unconfirmed ? null : 'confirmed' } : null }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn(async () => ({ success: h.delivery })) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  auth: { admin: { generateLink: async () => ({ data: { properties: { hashed_token: 'hash' } }, error: h.linkError ? new Error('provider') : null }) } },
  from: (table: string) => { const calls: any[] = []; const result = h.results.shift(); const q: any = { then: (resolve: any) => Promise.resolve(result).then(resolve) };
    for (const method of ['select','eq','neq','in','gte','insert','update','single','maybeSingle']) q[method] = (...args: any[]) => { calls.push([method,...args]); return q; };
    h.queries.push({table,calls}); return q;
  }
}) }));
import { POST as invite, PATCH } from '../route';
import { POST as accept } from '../accept/route';
import { sendEmail } from '@/lib/email/client';
const request = (body: unknown) => new NextRequest('http://localhost/api/team', { method: 'POST', body: JSON.stringify(body) });
const member = { id: 'm', email: 'staff@example.com', status: 'invited', invited_at: new Date().toISOString(), business_id: 'b', role: 'staff' };
beforeEach(() => { h.user = {id:'owner',email:'staff@example.com',email_confirmed_at:'yes'}; h.results=[];h.queries=[];h.exists=false;h.unconfirmed=false;h.delivery=true;h.linkError=false;vi.clearAllMocks(); });
function invitationResults(existing: unknown = null) { h.results = [{data:{id:'b',owner_id:'owner',name:'Shop',subscription_tier:'business'}},{data:existing},{count:1},{data:{id:'m'}}]; }
describe('merchant invitations', () => {
 it('denies unauthenticated invitation', async()=>{h.user=null; expect((await invite(request({}))).status).toBe(401); expect(h.queries).toHaveLength(0);});
 it('rejects arbitrary and owner roles', async()=>{for(const role of ['owner','invalid']) expect((await invite(request({business_id:'b',email:member.email,role}))).status).toBe(400);});
 it('new account receives password setup callback',async()=>{invitationResults();expect((await invite(request({business_id:'b',email:' STAFF@example.com ',role:'staff'}))).status).toBe(201); const email=vi.mocked(sendEmail).mock.calls[0][0];expect(email.to).toBe(member.email);expect(email.html).toContain('token_hash=hash');expect(email.html).toContain('setup%3D1');});
 it('existing account receives direct accept link, without password reset',async()=>{h.exists=true;invitationResults();expect((await invite(request({business_id:'b',email:member.email,role:'staff'}))).status).toBe(201);expect(vi.mocked(sendEmail).mock.calls[0][0].html).not.toContain('token_hash');});
 it('resends setup for an unconfirmed identity left after failed delivery',async()=>{h.exists=true;h.unconfirmed=true;invitationResults({id:'m',status:'invited'});expect((await invite(request({business_id:'b',email:member.email,role:'staff'}))).status).toBe(201);expect(vi.mocked(sendEmail).mock.calls[0][0].html).toContain('type=recovery');expect(vi.mocked(sendEmail).mock.calls[0][0].html).toContain('setup%3D1');});
 it('allows retry of pending invitation',async()=>{h.exists=true;invitationResults({id:'m',status:'invited'});expect((await invite(request({business_id:'b',email:member.email,role:'staff'}))).status).toBe(201);expect(h.queries[3].calls).toContainEqual(['neq','status','active']);});
 it('reports email failure',async()=>{invitationResults();h.delivery=false;expect((await invite(request({business_id:'b',email:member.email,role:'staff'}))).status).toBe(502);});
 it('reports account setup failure',async()=>{invitationResults();h.linkError=true;expect((await invite(request({business_id:'b',email:member.email,role:'staff'}))).status).toBe(502);expect(sendEmail).not.toHaveBeenCalled();});
 it('denies role mutation by nonowner',async()=>{h.results=[{data:{owner_id:'other'}}];expect((await PATCH(request({business_id:'b',member_id:'m',role:'manager'}))).status).toBe(403);});
 it('denies wrong email and unverified email',async()=>{for(const user of [{email:'wrong@example.com',email_confirmed_at:'yes'},{email:member.email}]) {h.user={id:'u',...user};h.results=[{data:member}];expect((await accept(request({token:'t'}))).status).toBe(403);}});
 it('rejects expired invite',async()=>{h.results=[{data:{...member,invited_at:'2020-01-01'}}];expect((await accept(request({token:'t'}))).status).toBe(410);});
 it('does not claim acceptance after concurrent consumption or failed write',async()=>{for(const result of [{data:null},{data:null,error:{message:'failure'}}]) {h.results=[{data:member},result];expect((await accept(request({token:'t'}))).status).toBe(409);}});
 it('accepts verified recipient with token and status CAS',async()=>{h.results=[{data:member},{data:{id:'m'}},{data:{name:'Shop'}}];expect((await accept(request({token:'t'}))).status).toBe(200);expect(h.queries[1].calls).toContainEqual(['eq','invite_token','t']);expect(h.queries[1].calls).toContainEqual(['eq','status','invited']);});
});
