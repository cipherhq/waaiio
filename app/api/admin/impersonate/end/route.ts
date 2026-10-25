import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

/**
 * POST /api/admin/impersonate/end
 *
 * Clears impersonation cookies, ending the admin's impersonation session.
 *
 * Security model:
 * - This route is intentionally unauthenticated. The impersonation cookies
 *   use path=/dashboard and are NOT transmitted by browsers to /api/admin/*
 *   routes. The cookies cannot be read here to verify identity.
 * - Clearing nonexistent or already-cleared cookies is a no-op — an
 *   anonymous POST produces no security effect.
 * - The actual impersonation authority is validated in app/dashboard/layout.tsx
 *   which checks the admin role + token validity before granting impersonation.
 * - Cookies are httpOnly (no JS access), secure (HTTPS in production),
 *   sameSite=lax (no cross-origin POST), path=/dashboard (scoped).
 */
export async function POST() {
  const cookieStore = await cookies();

  cookieStore.set('impersonate_business_id', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/dashboard',
    maxAge: 0,
  });

  cookieStore.set('impersonate_admin_id', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/dashboard',
    maxAge: 0,
  });

  return NextResponse.json({ success: true });
}
