import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function POST() {
  const cookieStore = await cookies();

  // Auth guard: only allow ending impersonation when an active impersonation
  // session exists. The impersonate_admin_id cookie is set by the /validate
  // endpoint after a verified admin token exchange. requirePlatformAdmin()
  // cannot be used here because the user session on the main app domain
  // belongs to the impersonated merchant, not the admin.
  const adminId = cookieStore.get('impersonate_admin_id')?.value;
  if (!adminId) {
    return NextResponse.json({ error: 'No active impersonation session' }, { status: 401 });
  }

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
