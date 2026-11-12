import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const nativeError = (error: string, status = 422) => NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function ownedNativeForm(businessId: unknown, formId: unknown) {
  const db = await createClient();
  const { data: { user }, error } = await db.auth.getUser();
  if (error || !user) return { response: nativeError('Unauthorized', 401) };
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (typeof businessId !== 'string' || typeof formId !== 'string' || !uuid.test(businessId) || !uuid.test(formId)) {
    return { response: nativeError('Valid business and form IDs are required.', 400) };
  }
  const { data: business, error: ownerError } = await db.from('businesses').select('id').eq('id', businessId).eq('owner_id', user.id).maybeSingle();
  if (ownerError) return { response: nativeError('Ownership check unavailable.', 503) };
  if (!business) return { response: nativeError('Forbidden', 403) };
  const { data: form, error: formError } = await db.from('forms').select('id,business_id,title,description,fields,settings,is_active,token')
    .eq('id', formId).eq('business_id', businessId).maybeSingle();
  if (formError) return { response: nativeError('Form lookup unavailable.', 503) };
  if (!form) return { response: nativeError('Form not found.', 404) };
  return { form, businessId, formId };
}
