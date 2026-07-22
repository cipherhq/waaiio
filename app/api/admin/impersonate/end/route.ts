import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

export async function POST() {
  const cookieStore = await cookies();

  // Read business_id from cookie before clearing
  const businessId = cookieStore.get('impersonate_business_id')?.value;

  // Audit log: session ended
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user && businessId) {
      const service = createServiceClient();
      const { data: adminProfile } = await service.from('profiles').select('email').eq('id', user.id).maybeSingle();
      await service.from('impersonation_logs').insert({
        admin_id: user.id,
        admin_email: adminProfile?.email || 'unknown',
        target_business_id: businessId,
        action: 'session_ended',
      });
    }
  } catch (err) {
    logger.error('Impersonation end audit log error:', (err as Error).message);
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
