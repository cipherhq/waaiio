import { describe,it,expect } from 'vitest';
import {catalogDigest,catalogObjectsDigest,projectCatalog,verifyCatalogTransition} from '../full-release-catalog.mjs';
const h='1'.repeat(64), object=(identity:string,value:any)=>({identity,value});
function fixture(){
 const before=[object('table:public.fixture',{owner:'postgres',rls:true,acl:[]}),object('function:public.old()',{owner:'postgres',body:'old',acl:[]})];
 const trusted={environment:'production',phase:'pre_app',query_sha256:h,required_before:['table:public.fixture'],required_after:['table:public.fixture'],patches:[{identity:'column:public.fixture.additive',operation:'add',source_sha256:h,value:{type:'text',notnull:false}},{identity:'function:public.old()',operation:'fields',source_sha256:h,before:{body:['old']},fields:{body:'new'}}]};
 const binding={environment:'production',phase:'pre_app',query_sha256:h,before_catalog_sha256:catalogObjectsDigest(before)};
 const after=projectCatalog(before,trusted);
 return {trusted,binding,actual:{...binding,before,after,after_catalog_sha256:catalogObjectsDigest(after)}};
}
describe('fixed complete catalog phase projection',()=>{
 it('preserves untouched complete objects and accepts exact trusted patches',()=>{const f=fixture();expect(verifyCatalogTransition(f.actual,f.binding,f.trusted)).toBe(true)});
 it('does not let a report-provided patch select authority',()=>{const f=fixture();(f.actual as any).patches=[{operation:'remove',identity:'table:public.fixture'}];f.actual.after=f.actual.after.filter(x=>x.identity!=='table:public.fixture');f.actual.after_catalog_sha256=catalogObjectsDigest(f.actual.after);expect(()=>verifyCatalogTransition(f.actual,f.binding,f.trusted)).toThrow()});
 for(const changed of ['missing','duplicate','extra','owner','acl','body','before','digest','phase','environment'])it('rejects '+changed,()=>{const f=fixture();const a:any=f.actual;
 if(changed==='missing')a.after.pop();if(changed==='duplicate')a.after.push(a.after[0]);if(changed==='extra')a.after.push(object('table:public.other',{owner:'postgres'}));
 if(['owner','acl','body'].includes(changed)){const o=a.after.find((x:any)=>x.identity==='function:public.old()');o.value[changed]=changed==='acl'?[{grantee:'PUBLIC',privilege:'EXECUTE',grantable:true}]:'wrong'}
 if(changed==='before')a.before[0].value.owner='untrusted';if(changed==='digest')a.after_catalog_sha256='0'.repeat(64);if(changed==='phase')a.phase='post_app';if(changed==='environment')a.environment='staging';
 expect(()=>verifyCatalogTransition(a,f.binding,f.trusted)).toThrow();});
 it('requires complete before binding even with internally recomputed observations',()=>{const f=fixture();f.actual.before[0].value.rls=false;f.actual.before_catalog_sha256=catalogObjectsDigest(f.actual.before);f.actual.after=projectCatalog(f.actual.before,f.trusted);f.actual.after_catalog_sha256=catalogObjectsDigest(f.actual.after);expect(()=>verifyCatalogTransition(f.actual,f.binding,f.trusted)).toThrow()});
 it('rejects add over existing identity',()=>{const f=fixture();f.trusted.patches[0].identity='table:public.fixture';expect(()=>projectCatalog(f.actual.before,f.trusted)).toThrow()});
 it('rejects unrecognized before definition',()=>{const f=fixture();f.actual.before[1].value.body='unreviewed';expect(()=>projectCatalog(f.actual.before,f.trusted)).toThrow()});
 it('rejects duplicate patch identity',()=>{const f=fixture();f.trusted.patches.push(f.trusted.patches[0]);expect(()=>projectCatalog(f.actual.before,f.trusted)).toThrow()});
 it('can remove an exact known superseded object and refuses a drifted one',()=>{const f=fixture();const p:any={environment:'production',phase:'post_app',required_before:[],required_after:[],patches:[{identity:f.actual.before[1].identity,operation:'remove',source_sha256:h,before_sha256:[catalogDigest(f.actual.before[1].value)]}]};expect(projectCatalog(f.actual.before,p)).toHaveLength(1);f.actual.before[1].value.owner='other';expect(()=>projectCatalog(f.actual.before,p)).toThrow()});
 it('ensure permits exact existing foundation but rejects an incompatible object',()=>{const f=fixture();const p:any={required_before:[],required_after:[],patches:[{identity:f.actual.before[0].identity,operation:'ensure',source_sha256:h,value:structuredClone(f.actual.before[0].value)}]};expect(projectCatalog(f.actual.before,p)).toHaveLength(2);f.actual.before[0].value.rls=false;expect(()=>projectCatalog(f.actual.before,p)).toThrow()});
 it('rejects omission of an unchanged required prerequisite even with consistent rebinding',()=>{const f=fixture();f.actual.before=f.actual.before.filter(x=>x.identity!=='table:public.fixture');f.actual.after=f.actual.after.filter(x=>x.identity!=='table:public.fixture');f.binding.before_catalog_sha256=f.actual.before_catalog_sha256=catalogObjectsDigest(f.actual.before);f.actual.after_catalog_sha256=catalogObjectsDigest(f.actual.after);expect(()=>verifyCatalogTransition(f.actual,f.binding,f.trusted)).toThrow()});
 it('rejects a changed observation query',()=>{const f=fixture();f.actual.query_sha256='2'.repeat(64);expect(()=>verifyCatalogTransition(f.actual,f.binding,f.trusted)).toThrow()});
 it('does not mutate evidence inputs',()=>{const f=fixture();const old=JSON.stringify(f);verifyCatalogTransition(f.actual,f.binding,f.trusted);expect(JSON.stringify(f)).toBe(old)});
});

import {FULL_CATALOG_CONTRACTS,verifyFullCatalogPhase,fullKnownComponentProjection,verifyFullKnownComponents} from '../full-release-evidence.mjs';
function fixedFixture(environment:string,phase:string){
 const trusted=FULL_CATALOG_CONTRACTS.profiles[environment].phases[phase];
 const m=new Map(trusted.required_before.map((id:string)=>[id,{fixture_preserved:true}]));
 for(const p of trusted.patches){
  if(p.operation==='add')continue;
  const value:any={...(m.get(p.identity)||{}),...p.preconditions};
  for(const [key,v] of Object.entries(p.fields||{}))value[key]=structuredClone(v);
  m.set(p.identity,value);
 }
 const before=[...m].map(([identity,value])=>({identity,value}));
 const after=projectCatalog(before,trusted);
 const binding={environment,phase,query_sha256:trusted.query_sha256,before_catalog_sha256:catalogObjectsDigest(before)};
 return {binding,actual:{...binding,before,after,after_catalog_sha256:catalogObjectsDigest(after)}};
}
describe('complete fixed phase policy using synthetic metadata fixtures',()=>{
 for(const environment of ['staging','production'])for(const phase of ['pre_app','post_app']){
  it(`${environment} ${phase} accepts only its exact deterministic projection`,()=>{const f=fixedFixture(environment,phase);expect(verifyFullCatalogPhase(environment,phase,f.actual,f.binding)).toBe(true)});
  it(`${environment} ${phase} rejects missing unchanged prerequisites`,()=>{const f=fixedFixture(environment,phase);const trusted=FULL_CATALOG_CONTRACTS.profiles[environment].phases[phase];const preserved=trusted.required_before.find((id:string)=>!trusted.patches.some((p:any)=>p.identity===id));expect(preserved).toBeTruthy();f.actual.before=f.actual.before.filter(x=>x.identity!==preserved);f.actual.after=f.actual.after.filter(x=>x.identity!==preserved);f.binding.before_catalog_sha256=f.actual.before_catalog_sha256=catalogObjectsDigest(f.actual.before);f.actual.after_catalog_sha256=catalogObjectsDigest(f.actual.after);expect(()=>verifyFullCatalogPhase(environment,phase,f.actual,f.binding)).toThrow()});
  it(`${environment} ${phase} rejects source-authority substitutions`,()=>{const f=fixedFixture(environment,phase);expect(()=>verifyFullCatalogPhase(environment==='production'?'staging':'production',phase,f.actual,f.binding)).toThrow();expect(()=>verifyFullCatalogPhase(environment,phase==='pre_app'?'post_app':'pre_app',f.actual,f.binding)).toThrow()});
 }
 it('keeps production435 contracted authority exclusively post-app',()=>{const pre=fullKnownComponentProjection('production','pre_app'),post=fullKnownComponentProjection('production','post_app');expect(pre.financial_functions.some((f:any)=>f.identity.startsWith('create_order_atomic('))).toBe(false);expect(post.financial_functions.filter((f:any)=>f.identity.startsWith('create_order_atomic('))).toHaveLength(1);expect(()=>verifyFullKnownComponents('production',post,'pre_app')).toThrow();expect(verifyFullKnownComponents('production',pre,'pre_app')).toBe(true)});
});

describe('canonical bank-account policy removal contract',()=>{
 const names=['Owners manage bank accounts','Resellers manage sub-account bank accounts'];
 const ids=names.map(n=>`policy:public.business_bank_accounts.${n}`);
 const phase=FULL_CATALOG_CONTRACTS.profiles.production.phases.pre_app;
 const patches=phase.patches.filter((p:any)=>ids.includes(p.identity));
 it('requires exactly the two canonical source-bound removals',()=>{
  expect(patches).toHaveLength(2);
  for(const p of patches){expect(p.operation).toBe('remove-bound');expect(p.source_sha256).toBe('bd15cf736cdb4082b20a9f7af96829b8ffdf44b580d2f41640f475f60601f13f');expect(p.preconditions).toMatchObject({roles:['public'],command:'ALL',permissive:'PERMISSIVE',with_check:null});expect(p.preconditions.using).toEqual(expect.any(String));}
 });
 it('deletes only the exact policies and preserves an unrelated policy',()=>{
  const retained=object('policy:public.business_bank_accounts.Admin reads bank accounts',{command:'SELECT',roles:['authenticated']});
  const before=[...patches.map((p:any)=>object(p.identity,structuredClone(p.preconditions))),retained];
  expect(projectCatalog(before,{patches,required_before:[],required_after:[retained.identity]})).toEqual([retained]);
 });
 it.each(['roles','command','permissive','using','with_check'])('rejects unexpected %s metadata before deleting a policy',key=>{
  const before=patches.map((p:any)=>object(p.identity,structuredClone(p.preconditions)));before[0].value[key]=key==='roles'?['authenticated']:'unexpected';
  expect(()=>projectCatalog(before,{patches,required_before:[],required_after:[]})).toThrow();
 });
 it('rejects an already omitted policy rather than weakening the baseline',()=>{
  expect(()=>projectCatalog([object(patches[0].identity,patches[0].preconditions)],{patches,required_before:[],required_after:[]})).toThrow();
 });
});


describe('canonical server-only function permissions',()=>{
 const names=['persist_verified_paystack_card_authorization','create_ticket_booking_checked'];
 const acl=['postgres','service_role'].map(grantee=>({grantee,grantor:'postgres',grantable:false,privilege:'EXECUTE'}));
 for(const name of names){
  it(`accepts canonical service-only permissions for ${name}`,()=>{
   const f=fixedFixture('production','pre_app');
   const target=f.actual.after.find(x=>x.identity.startsWith(`function:public.${name}(`));
   expect(target).toBeDefined();target!.value.acl=structuredClone(acl);
   f.actual.after_catalog_sha256=catalogObjectsDigest(f.actual.after);
   expect(verifyFullCatalogPhase('production','pre_app',f.actual,f.binding)).toBe(true);
  });
  it.each(['PUBLIC','anon','authenticated'])(`rejects added %s execution for ${name}`,grantee=>{
   const f=fixedFixture('production','pre_app');
   const target=f.actual.after.find(x=>x.identity.startsWith(`function:public.${name}(`));
   target!.value.acl=[...structuredClone(acl),{grantee,grantor:'postgres',grantable:false,privilege:'EXECUTE'}];
   f.actual.after_catalog_sha256=catalogObjectsDigest(f.actual.after);
   expect(()=>verifyFullCatalogPhase('production','pre_app',f.actual,f.binding)).toThrow();
  });
 }
});

describe('canonical provider-plan function signature replacement',()=>{
 const oldId='function:public.save_provider_plan_refs(p_country_code text, p_plan_refs jsonb, p_expected_version_id uuid, p_actor_id uuid)';
 const phase=FULL_CATALOG_CONTRACTS.profiles.production.phases.pre_app;
 const patch=phase.patches.find((p:any)=>p.identity===oldId);
 it('binds the sole removal to its canonical source and complete prior metadata',()=>{
  expect(patch.operation).toBe('remove-bound');expect(patch.source_sha256).toBe('2f37c5341905f44f8d1729beeaca32d7fe07633f60ae805fc47e0d6f9bf81cc0');
  expect(Object.keys(patch.preconditions).sort()).toEqual(['acl','arguments','body_sha256','config','definer','kind','language','leakproof','owner','parallel','returns','strict','volatility']);
  expect(FULL_CATALOG_CONTRACTS.profiles.production.phases.post_app.patches.some((p:any)=>p.identity===oldId)).toBe(false);
  expect(FULL_CATALOG_CONTRACTS.profiles.staging.phases.pre_app.patches.some((p:any)=>p.identity===oldId)).toBe(false);
 });
 it('accepts canonical absence and denies retaining the old signature',()=>{
  const f=fixedFixture('production','pre_app');expect(f.actual.after.some(x=>x.identity===oldId)).toBe(false);
  expect(verifyFullCatalogPhase('production','pre_app',f.actual,f.binding)).toBe(true);
  f.actual.after.push(object(oldId,structuredClone(patch.preconditions)));f.actual.after_catalog_sha256=catalogObjectsDigest(f.actual.after);
  expect(()=>verifyFullCatalogPhase('production','pre_app',f.actual,f.binding)).toThrow();
 });
 it.each(['acl','body_sha256','owner','config','arguments'])('rejects changed prior %s',key=>{
  const before=[object(oldId,structuredClone(patch.preconditions))];before[0].value[key]=key==='acl'?[]:'unexpected';
  expect(()=>projectCatalog(before,{patches:[patch],required_before:[],required_after:[]})).toThrow();
 });
 it('preserves absence through the cumulative post-app projection',()=>{
  const f=fixedFixture('production','pre_app');const post=FULL_CATALOG_CONTRACTS.profiles.production.phases.post_app;
  // Populate unrelated pre-existing post-phase metadata in the synthetic baseline.
  // Both complete trusted phases still execute; no patch or precondition is omitted.
  for(const p of post.patches){let existing=f.actual.before.find(x=>x.identity===p.identity);if(!existing&&p.operation!=='add'){existing=object(p.identity,structuredClone(p.preconditions||{}));f.actual.before.push(existing);}if(existing){if(p.preconditions)Object.assign(existing.value,structuredClone(p.preconditions));for(const [key,value] of Object.entries(p.fields||{}))if(!Object.hasOwn(existing.value,key))existing.value[key]=structuredClone(value);}}
  const pre=projectCatalog(f.actual.before,phase);const after=projectCatalog(pre,post);
  expect(after.some(x=>x.identity===oldId)).toBe(false);
  expect(after.some(x=>x.identity.startsWith('function:public.save_provider_plan_refs('))).toBe(true);
 });
});
