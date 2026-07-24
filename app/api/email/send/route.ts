import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email/client';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { requirePlatformAdmin } from '@/lib/admin-auth';

export async function POST(request: NextRequest) {
  const rl = await rateLimitResponseAsync(getRateLimitKey(request, 'email-send'), 20, 60_000);
  if (rl) return rl;

  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createClient();

  const body = await request.json();
  const { to, subject, html } = body;

  if (!to || !subject || !html) {
    return NextResponse.json(
      { error: 'Missing required fields: to, subject, html' },
      { status: 400 },
    );
  }

  const result = await sendEmail({ to, subject, html });

  if (!result.success) {
    return NextResponse.json({ error: 'Failed to send email' }, { status: 500 });
  }

  // Audit log
  await supabase.from('admin_audit_logs').insert({
    actor_id: admin.userId,
    action: 'send_email',
    entity_type: 'email',
    entity_id: null,
    details: { to, subject },
  });

  return NextResponse.json({ success: true });
}
