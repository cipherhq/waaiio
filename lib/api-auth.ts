import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createServiceClient } from '@/lib/supabase/service';
import { resolveBusinessRole } from '@/lib/capabilities/resolve-role';

/**
 * Authenticate an API request and optionally verify business ownership.
 *
 * Returns { user, businessId, service } on success, or a NextResponse error.
 *
 * Usage:
 *   const auth = await authenticateRequest(request, { requireBusinessOwnership: true });
 *   if (auth instanceof NextResponse) return auth;
 *   const { user, service } = auth;
 */
export async function authenticateRequest(
  request: NextRequest,
  options: {
    /** If true, expects businessId in body/query and verifies the user owns it */
    requireBusinessOwnership?: boolean;
    /** If provided, reads businessId from this key in the parsed body */
    businessIdKey?: string;
    /** Pre-parsed request body (since body can only be read once) */
    body?: Record<string, unknown>;
  } = {},
): Promise<
  | NextResponse
  | {
      user: { id: string; email?: string };
      businessId?: string;
      service: ReturnType<typeof createServiceClient>;
    }
> {
  // Create a Supabase client that reads session cookies
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(_cookies: { name: string; value: string; options: CookieOptions }[]) {
          // API routes don't need to set cookies
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const service = createServiceClient();

  if (options.requireBusinessOwnership) {
    const key = options.businessIdKey || 'businessId';

    // Try body first, then query params
    let businessId: string | null = null;
    if (options.body) {
      businessId = (options.body[key] as string) || (options.body['business_id'] as string) || null;
    }
    if (!businessId) {
      businessId = request.nextUrl.searchParams.get(key)
        || request.nextUrl.searchParams.get('business_id');
    }

    if (!businessId) {
      return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
    }

    // Verify the user owns this business
    const { data: business } = await service
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Forbidden: you do not own this business' }, { status: 403 });
    }

    return { user: { id: user.id, email: user.email }, businessId, service };
  }

  return { user: { id: user.id, email: user.email }, service };
}

/**
 * For public routes that show extra details to the business's own team.
 *
 * Returns true only when the request carries a signed-in session whose user is
 * the owner, or an active team member (business_members), of `businessId`.
 * A missing session, a failed lookup, or any error returns false, so callers
 * fall back to the public view. A business id in the URL or body is never
 * treated as proof of who is asking.
 */
export async function isSignedInBusinessMember(
  request: NextRequest,
  service: ReturnType<typeof createServiceClient>,
  businessId: string | null | undefined,
): Promise<boolean> {
  if (!businessId) return false;
  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(_cookies: { name: string; value: string; options: CookieOptions }[]) {
            // Read-only check; no cookies are set here
          },
        },
      },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const role = await resolveBusinessRole(service, businessId, user.id);
    return role.ok;
  } catch {
    return false;
  }
}
