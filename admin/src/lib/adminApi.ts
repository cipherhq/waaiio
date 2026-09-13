/**
 * Admin API Client — canonical authenticated helper for main-app Admin API calls.
 *
 * Uses VITE_API_URL per admin/.env.example.
 * Never silently falls back to production in Preview/Staging.
 * Local dev (localhost) is the only implicit fallback.
 */

import { supabase } from './supabase';

/**
 * Resolve the Admin API base URL.
 * - Uses VITE_API_URL if configured (Preview/Staging/Production).
 * - Falls back to localhost:3000 ONLY when running on localhost.
 * - Throws visibly if VITE_API_URL is missing outside local dev.
 */
export function getAdminApiBase(
  /** Optional hostname override for testing. Production callers omit this. */
  hostnameOverride?: string,
): string {
  const configured = import.meta.env.VITE_API_URL;
  if (configured) return configured;
  // Local dev: Vite dev server on 8083, Next.js on 3000
  const hostname = hostnameOverride ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  if (hostname === 'localhost') {
    return 'http://localhost:3000';
  }
  throw new Error('VITE_API_URL is not configured. Set it in your .env file.');
}

/**
 * Authenticated fetch to main-app Admin API. Attaches Bearer access_token.
 * Fails visibly if not authenticated or API base is missing.
 */
export async function adminApiFetch(path: string, body: Record<string, unknown>): Promise<Response> {
  const base = getAdminApiBase();
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Not authenticated — please sign in again.');
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
