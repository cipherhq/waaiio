import type { SupabaseClient } from '@supabase/supabase-js';

export const VERIFICATION_BUCKET = 'verification-documents';

/** Durable locator, never an expiring signed URL or an arbitrary remote address. */
export function verificationLocator(businessId: string, path: string) {
  if (!path.startsWith(`${businessId}/`) || path.includes('..')) throw new Error('Invalid document path');
  return `storage://${VERIFICATION_BUCKET}/${path}`;
}

export function parseVerificationLocator(value: string, businessId: string, supabaseUrl: string) {
  const url = new URL(value);
  let bucket: string;
  let path: string;
  if (url.protocol === 'storage:' && url.hostname === VERIFICATION_BUCKET) {
    bucket = VERIFICATION_BUCKET;
    path = decodeURIComponent(url.pathname.slice(1));
  } else {
    // Transition support for existing records, only this project's public verification objects.
    const prefix = '/storage/v1/object/public/business-documents/';
    if (url.origin !== new URL(supabaseUrl).origin || !url.pathname.startsWith(prefix) || url.search || url.hash) throw new Error('Invalid document locator');
    bucket = 'business-documents';
    path = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!path.startsWith(`${businessId}/verification/`) && !path.startsWith(`verification/${businessId}/`)) throw new Error('Invalid legacy path');
  }
  if (path.includes('..') || path.includes('\\') || !path ||
      (bucket === VERIFICATION_BUCKET && !path.startsWith(`${businessId}/`))) throw new Error('Invalid document path');
  return { bucket, path };
}

export async function signVerificationDocument(service: SupabaseClient, doc: { file_url: string; business_id: string }) {
  const { bucket, path } = parseVerificationLocator(doc.file_url, doc.business_id, process.env.NEXT_PUBLIC_SUPABASE_URL || '');
  const { data, error } = await service.storage.from(bucket).createSignedUrl(path, 300);
  if (error || !data?.signedUrl) throw new Error('Document unavailable');
  return data.signedUrl;
}
