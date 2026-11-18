/**
 * Platform-wide customer suspension for Edge Function sends (#1103 follow-up).
 *
 * Edge Functions cannot import lib/customer-suspension.ts, so this mirrors its
 * blocksReminder rule: a service-role read of public.customer_suspensions
 * (RLS deny-all; service role only), keyed on E.164 digits without '+'.
 * Fails closed: an unreadable status blocks the send. A number that is not
 * E.164 digits can never match a suspension key, so it is not blocked here.
 *
 * Runtime-neutral (no Deno imports), so the Node test suite runs it as is.
 */

// Loose on purpose: a precise structural type makes Deno compare it against the
// full supabase-js client type, which is too deep to check.
// deno-lint-ignore no-explicit-any
type SupabaseClient = { from(table: string): any };

const CANONICAL = /^[1-9]\d{6,14}$/;

export async function customerSendBlocked(
  supabase: SupabaseClient,
  phone: string | null | undefined,
): Promise<boolean> {
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  if (!CANONICAL.test(digits)) return false;
  try {
    const { data, error } = await supabase.from('customer_suspensions')
      .select('id').eq('phone', digits).maybeSingle();
    if (error) return true;
    return !!data;
  } catch {
    return true;
  }
}
