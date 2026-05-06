import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabaseServiceKey = import.meta.env.VITE_SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Check your .env file.');
}

// Auth client — uses anon key for login/session management
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Admin data client — uses service key to bypass RLS for admin data queries
// Only used in admin pages for read operations
export const adminDb = createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey);
