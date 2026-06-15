import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { bindSession } from '@/lib/security/session-bind';

/**
 * POST /api/auth/session-bind
 * Called by the browser after successful login to record session metadata.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session?.user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';
    const country = request.headers.get('x-vercel-ip-country') || undefined;

    await bindSession({
      userId: session.user.id,
      sessionId: session.access_token.slice(-32), // Use last 32 chars as stable session identifier
      ip,
      userAgent,
      country,
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
