import { createClient as createSupabaseClient } from '@supabase/supabase-js';

interface ServiceClientOptions {
  noStore?: boolean;
}

/**
 * Service-role Supabase client — bypasses RLS.
 * Only use in server-side API routes for admin operations.
 */
export function createServiceClient(options: ServiceClientOptions = {}) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  if (options.noStore) {
    return createSupabaseClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
      },
    });
  }

  return createSupabaseClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
