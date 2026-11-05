import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseVerificationLocator, verificationLocator, VERIFICATION_BUCKET } from './documents';

export interface VerificationMove {
  businessId: string;
  sourcePath: string;
  documentIds: string[];
  sha256: string;
}

/** Exact-manifest, restartable move. Never edit storage.objects directly. */
export async function relocateVerificationObject(service: SupabaseClient, projectUrl: string, move: VerificationMove) {
  if (new URL(projectUrl).hostname !== 'tqjvrzopvtczxfxiwmnz.supabase.co') throw new Error('Staging project required');
  if (!/^[a-f0-9]{64}$/.test(move.sha256)) throw new Error('Verified manifest checksum required');
  const sourceUrl = `${projectUrl}/storage/v1/object/public/business-documents/${move.sourcePath}`;
  parseVerificationLocator(sourceUrl, move.businessId, projectUrl);
  // Deterministic destination makes retries safe, including unreferenced legacy uploads.
  const target = `${move.businessId}/legacy-${createHash('sha256').update(move.sourcePath).digest('hex')}`;
  const locator = verificationLocator(move.businessId, target);
  const identityUrl = service.storage.from(VERIFICATION_BUCKET).getPublicUrl('identity-check').data.publicUrl;
  if (new URL(identityUrl).origin !== new URL(projectUrl).origin) throw new Error('Staging storage client required');
  const source = service.storage.from('business-documents');
  const dest = service.storage.from(VERIFICATION_BUCKET);
  const { data: original, error: originalError } = await source.download(move.sourcePath);
  const sourceMissing = originalError && 'statusCode' in originalError && String(originalError.statusCode) === '404';
  if ((originalError && !sourceMissing) || (!original && !sourceMissing)) throw new Error('Original unavailable; manual reconciliation required');
  const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  if (original && digest(Buffer.from(await original.arrayBuffer())) !== move.sha256) throw new Error('Original changed since manifest');
  const { data: existing } = await dest.download(target);
  if (!existing) {
    if (!original) throw new Error('Private copy missing');
    const { error } = await source.copy(move.sourcePath, target, { destinationBucket: VERIFICATION_BUCKET });
    if (error) throw new Error('Private copy failed');
  }
  const { data: copied, error: copyError } = await dest.download(target);
  if (copyError || !copied) throw new Error('Private copy verification failed');
  if (move.sha256 !== digest(Buffer.from(await copied.arrayBuffer()))) throw new Error('Private copy checksum mismatch');
  for (const id of move.documentIds) {
    const { data: doc, error } = await service.from('business_documents').select('id,business_id,file_url').eq('id',id).eq('business_id',move.businessId).single();
    if(error || !doc) throw new Error('Document mapping changed');
    if(doc.file_url !== locator) {
      if (!original) throw new Error('Original missing before locator update');
      const parsed=parseVerificationLocator(doc.file_url,move.businessId,projectUrl);
      if(parsed.bucket!=='business-documents'||parsed.path!==move.sourcePath) throw new Error('Document mapping changed');
      const {data:updated,error:updateError}=await service.from('business_documents').update({file_url:locator}).eq('id',id).eq('business_id',move.businessId).eq('file_url',doc.file_url).select('id');
      if(updateError||updated?.length!==1)throw new Error('Document locator update failed');
    }
  }
  // Check parsed references too: percent-encoded URLs may refer to the same object.
  for (let offset = 0; ; offset += 1000) {
    const {data:refs,error}=await service.from('business_documents').select('file_url').order('id').range(offset,offset+999);
    if(error||!refs)throw new Error('Reference inventory failed');
    for(const ref of refs) {
      let parsed;
      try { parsed=parseVerificationLocator(ref.file_url,move.businessId,projectUrl); } catch { continue; }
      if(parsed.bucket==='business-documents'&&parsed.path===move.sourcePath)throw new Error('Unmigrated document references remain');
    }
    if(refs.length<1000)break;
  }
  if (original) {
    const {error:removeError}=await source.remove([move.sourcePath]);
    if(removeError)throw new Error('Public original removal failed');
  }
  return { locator, sha256:move.sha256 };
}
