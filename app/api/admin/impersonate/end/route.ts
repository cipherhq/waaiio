import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

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
