import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

export async function createWhatsAppUser(
  supabase: SupabaseClient,
  phone: string,
  firstName: string,
  lastName: string,
  email?: string,
): Promise<string | null> {
  const fullPhone = phone.startsWith('+') ? phone : `+${phone}`;
  const phoneWithout = phone.startsWith('+') ? phone.slice(1) : phone;

  try {
    const createPayload: Record<string, unknown> = {
      phone: fullPhone,
      phone_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName },
    };
    if (email) {
      createPayload.email = email;
      createPayload.email_confirm = true;
    }

    const { data: authData, error: authError } = await supabase.auth.admin.createUser(createPayload);

    if (authError) {
      // Try lookup by phone (check both +phone and phone formats)
      const { data: byPhone } = await supabase
        .from('profiles')
        .select('id')
        .or(`phone.eq.${sanitizeFilterValue(fullPhone)},phone.eq.${sanitizeFilterValue(phoneWithout)}`)
        .limit(1)
        .maybeSingle();

      if (byPhone?.id) {
        const updates: Record<string, string> = { first_name: firstName, last_name: lastName };
        if (email) updates.email = email;
        await supabase.from('profiles').update(updates).eq('id', byPhone.id);
        return byPhone.id;
      }

      // Try lookup by email
      if (email) {
        const { data: byEmail } = await supabase
          .from('profiles')
          .select('id')
          .eq('email', email)
          .maybeSingle();

        if (byEmail?.id) {
          await supabase
            .from('profiles')
            .update({ phone: fullPhone, first_name: firstName, last_name: lastName })
            .eq('id', byEmail.id);
          return byEmail.id;
        }

        // Retry without email
        const { data: retryData, error: retryError } = await supabase.auth.admin.createUser({
          phone: fullPhone,
          phone_confirm: true,
          user_metadata: { first_name: firstName, last_name: lastName },
        });

        if (!retryError && retryData?.user) {
          await supabase
            .from('profiles')
            .update({ first_name: firstName, last_name: lastName })
            .eq('id', retryData.user.id);
          return retryData.user.id;
        }
      }

      return null;
    }

    const userId = authData.user.id;
    const profileUpdate: Record<string, string> = { first_name: firstName, last_name: lastName };
    if (email) profileUpdate.email = email;
    await supabase.from('profiles').update(profileUpdate).eq('id', userId);

    return userId;
  } catch (error) {
    console.error('createWhatsAppUser error:', (error as Error).message);

    try {
      const { data: fallback } = await supabase
        .from('profiles')
        .select('id')
        .or(`phone.eq.${sanitizeFilterValue(fullPhone)},phone.eq.${sanitizeFilterValue(phoneWithout)}`)
        .limit(1)
        .maybeSingle();
      if (fallback?.id) return fallback.id;
    } catch (err) { logger.warn('[USER] Fallback lookup failed:', err); }

    return null;
  }
}

export async function findUserByPhone(
  supabase: SupabaseClient,
  phone: string,
): Promise<{ id: string; first_name: string; last_name: string; email: string | null } | null> {
  const fullPhone = phone.startsWith('+') ? phone : `+${phone}`;
  const phoneWithout = phone.startsWith('+') ? phone.slice(1) : phone;
  const { data } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, email')
    .or(`phone.eq.${sanitizeFilterValue(fullPhone)},phone.eq.${sanitizeFilterValue(phoneWithout)}`)
    .limit(1)
    .maybeSingle();
  return data || null;
}

/** Get a customer's display name by phone number. Returns "First Last" or null. */
export async function getCustomerName(supabase: SupabaseClient, phone: string): Promise<string | null> {
  const user = await findUserByPhone(supabase, phone);
  if (user?.first_name) return `${user.first_name} ${user.last_name || ''}`.trim();
  return null;
}
