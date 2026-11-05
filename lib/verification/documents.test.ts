import { describe, it, expect, vi } from 'vitest';
import { parseVerificationLocator, verificationLocator, signVerificationDocument } from './documents';
const business='11111111-1111-4111-a111-111111111111';
const origin='https://synthetic.supabase.co';
describe('verification document locators',()=>{
 it('uses durable private locators scoped to business',()=>{
  const value=verificationLocator(business,`${business}/file.pdf`);
  expect(parseVerificationLocator(value,business,origin)).toEqual({bucket:'verification-documents',path:`${business}/file.pdf`});
 });
 it.each([`${business}/verification/file.pdf`,`verification/${business}/file.pdf`])('recognizes only approved legacy layout %s',path=>{
  expect(parseVerificationLocator(`${origin}/storage/v1/object/public/business-documents/${path}`,business,origin)).toEqual({bucket:'business-documents',path});
 });
 it.each(['https://evil.example/file','storage://verification-documents/other/file.pdf','storage://other-bucket/file','https://synthetic.supabase.co/storage/v1/object/public/business-documents/other/verification/file.pdf',`storage://verification-documents/${business}/%2e%2e%2fother/file`])('denies malformed or cross-tenant locator %s',url=>{
  expect(()=>parseVerificationLocator(url,business,origin)).toThrow();
 });
 it('creates only a short lived signed URL after locator validation',async()=>{
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',origin);
  const createSignedUrl=vi.fn().mockResolvedValue({data:{signedUrl:'signed'}}); const from=vi.fn(()=>({createSignedUrl}));
  const service={storage:{from}} as unknown as Parameters<typeof signVerificationDocument>[0];
  expect(await signVerificationDocument(service,{business_id:business,file_url:verificationLocator(business,`${business}/file.pdf`)})).toBe('signed');
  expect(from).toHaveBeenCalledWith('verification-documents'); expect(createSignedUrl).toHaveBeenCalledWith(`${business}/file.pdf`,300);
  await expect(signVerificationDocument(service,{business_id:business,file_url:'https://evil.example/file'})).rejects.toThrow();
  expect(createSignedUrl).toHaveBeenCalledTimes(1);
 });
});
