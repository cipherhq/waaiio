import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Check your .env file.');
}

// SECURITY: Never use VITE_ prefix for service role keys — they get bundled into
// the browser JS and anyone with DevTools can extract them. All admin data
// operations go through authenticated /api/admin/* routes on the main app.

// Main client — uses anon key for auth (login, session, signOut)
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Admin data client — uses the same anon key + user's auth session.
// RLS policies grant access based on the user's admin/support role.
export const adminDb = supabase;
