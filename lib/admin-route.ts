/**
 * Small helpers shared by the /api/admin/* routes that replaced direct
 * admin-panel table writes (#1108 X1–X3). Each route still does its own
 * requirePlatformAdmin role check; these only remove repeated plumbing.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { adminCorsHeaders } from '@/lib/admin-cors';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** JSON responder with admin CORS and no caching. */
export function adminResponder(request: NextRequest, methods = 'POST, OPTIONS') {
  const headers = { ...adminCorsHeaders(request.headers.get('origin'), methods), 'Cache-Control': 'private, no-store' };
  return (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
}

export function adminPreflight(request: NextRequest, methods = 'POST, OPTIONS') {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), methods) });
}

export function adminRequestIp(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}

/** Parse a JSON object body. Returns null for invalid JSON, arrays and primitives. */
export async function readJsonObject(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Look up business names for display. A read failure returns an empty map. */
export async function businessNames(
  service: { from: (table: string) => any },
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return new Map();
  const { data } = await service.from('businesses').select('id, name').in('id', unique);
  return new Map(((data || []) as Array<{ id: string; name: string | null }>).map(b => [b.id, b.name || 'Unknown']));
}
