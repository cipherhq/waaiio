import { supabase } from './supabase';

const API_URL = import.meta.env.VITE_API_URL || '';

interface QueryFilter {
  column: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is';
  value: unknown;
}

interface QueryOptions {
  select?: string;
  filters?: QueryFilter[];
  order?: { column: string; ascending?: boolean };
  limit?: number;
  count?: 'exact';
}

/**
 * Query any table through the admin API proxy (bypasses RLS).
 * Use this instead of supabase.from(...) for read operations.
 */
export async function adminQuery<T = Record<string, unknown>>(
  table: string,
  options: QueryOptions = {},
): Promise<{ data: T[] | null; count?: number; error?: string }> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (!token) return { data: null, error: 'Not authenticated' };

    const res = await fetch(`${API_URL}/api/admin/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        table,
        select: options.select || '*',
        filters: options.filters || [],
        order: options.order,
        limit: options.limit,
        count: options.count,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      return { data: null, error: err.error || 'Request failed' };
    }

    const result = await res.json();
    return { data: result.data as T[], count: result.count };
  } catch (error) {
    return { data: null, error: (error as Error).message };
  }
}
