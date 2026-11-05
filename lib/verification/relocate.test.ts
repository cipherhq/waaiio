import {beforeEach,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {relocateVerificationObject} from './relocate';
const business='11111111-1111-4111-a111-111111111111';const url='https://tqjvrzopvtczxfxiwmnz.supabase.co';
const bytes='synthetic verification fixture';const sha256=createHash('sha256').update(bytes).digest('hex');
const path=`${business}/verification/id.pdf`;const old=`${url}/storage/v1/object/public/business-documents/${path}`;
const target=`${business}/legacy-${createHash('sha256').update(path).digest('hex')}`;
const locator=`storage://verification-documents/${target}`;
let sourcePresent:boolean, copied:boolean, contents:string, stored:string, remaining:number, reference:string;
const remove=vi.fn(),copy=vi.fn();
beforeEach(()=>{vi.clearAllMocks();sourcePresent=true;copied=false;contents=bytes;stored=old;remaining=0;reference=old;remove.mockImplementation(async()=>{sourcePresent=false;return {error:null}});copy.mockImplementation(async()=>{copied=true;return {error:null}})});
function client(){return {storage:{from:(bucket:string)=>({getPublicUrl:()=>({data:{publicUrl:`${url}/storage/v1/object/public/verification-documents/identity-check`}}),download:async()=>bucket==='business-documents'?(sourcePresent?{data:new Blob([bytes])}:{error:{statusCode:'404'}}):(copied?{data:new Blob([contents])}:{error:{statusCode:'404'}}),copy,remove})},from:()=>{let updating=false;let next='';const chain={select:()=>chain,order:()=>chain,range:async()=>({data:remaining?[{file_url:reference}]:[]}),eq:()=>chain,single:async()=>({data:{id:'doc',business_id:business,file_url:stored}}),update:(v:{file_url:string})=>{updating=true;next=v.file_url;return chain},then:(resolve:(v:unknown)=>unknown)=>{if(updating)stored=next;return Promise.resolve({data:[{id:'doc'}]}).then(resolve)}};return chain}} as unknown as Parameters<typeof relocateVerificationObject>[0]}
const move={businessId:business,sourcePath:path,documentIds:['doc'],sha256};
it('copies/checks private bytes and updates locator before deleting exact public source',async()=>{expect(await relocateVerificationObject(client(),url,move)).toEqual({locator,sha256});expect(stored).toBe(locator);expect(copy).toHaveBeenCalledWith(path,target,{destinationBucket:'verification-documents'});expect(remove).toHaveBeenCalledWith([path])});
it('is restartable after complete relocation',async()=>{await relocateVerificationObject(client(),url,move);await expect(relocateVerificationObject(client(),url,move)).resolves.toEqual({locator,sha256});expect(remove).toHaveBeenCalledTimes(1)});
it('does not delete original if private copy differs',async()=>{copied=true;contents='different';await expect(relocateVerificationObject(client(),url,move)).rejects.toThrow('checksum');expect(remove).not.toHaveBeenCalled();expect(stored).toBe(old)});
it('does not delete original with unmigrated references',async()=>{remaining=1;await expect(relocateVerificationObject(client(),url,move)).rejects.toThrow('references');expect(remove).not.toHaveBeenCalled()});
it('fails closed on changed document mapping',async()=>{stored=`storage://verification-documents/${business}/different`;await expect(relocateVerificationObject(client(),url,move)).rejects.toThrow('mapping');expect(remove).not.toHaveBeenCalled()});
it('refuses production project and changed original bytes',async()=>{await expect(relocateVerificationObject(client(),'https://production.supabase.co',move)).rejects.toThrow('Staging');await expect(relocateVerificationObject(client(),url,{...move,sha256:'a'.repeat(64)})).rejects.toThrow('changed');expect(copy).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled()});
it('supports exact-manifest orphan relocation without inventing a document row',async()=>{const result=await relocateVerificationObject(client(),url,{...move,documentIds:[]});expect(result.locator).toBe(locator);expect(stored).toBe(old);expect(remove).toHaveBeenCalledTimes(1)});

it('retains original if an encoded equivalent reference survives',async()=>{remaining=1;reference=old.replace('/id.pdf','/%69d.pdf');await expect(relocateVerificationObject(client(),url,move)).rejects.toThrow('references');expect(remove).not.toHaveBeenCalled()});
