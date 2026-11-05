import type { SupabaseClient } from '@supabase/supabase-js';

/** Server-only read after the caller has authorized access to the business. */
export async function getMerchantAccountingHold(
  serviceClient: SupabaseClient,
  businessId: string,
): Promise<boolean> {
  const { data, error } = await serviceClient
    .from('merchant_accounting_holds')
    .select('active')
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) throw new Error('Unable to verify merchant accounting hold');
  return data?.active === true;
}
