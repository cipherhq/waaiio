import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * POST /api/account/audit
 * Logs user-initiated account changes (password, email, consent) to admin_audit_logs.
 * Called client-side after successful auth mutations.
 *
 * Body: { action: string, details?: Record<string, unknown> }
 * Allowed actions: password_changed, email_changed, consent_updated
 */

const ALLOWED_ACTIONS = ['password_changed', 'email_changed', 'consent_updated'];

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { action, details } = body as { action: string; details?: Record<string, unknown> };

    if (!action || !ALLOWED_ACTIONS.includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    // Use service client to bypass RLS (admin_audit_logs insert requires admin role via RLS)
    const service = createServiceClient();
    await service.from('admin_audit_logs').insert({
      actor_id: user.id,
      action,
      entity_type: 'profile',
      entity_id: user.id,
      details: details || {},
    });

    return NextResponse.json({ logged: true });
  } catch (error) {
    logger.error('[ACCOUNT-AUDIT] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
