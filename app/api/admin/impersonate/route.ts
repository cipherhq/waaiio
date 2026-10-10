import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { randomBytes } from 'crypto';
import { logger } from '@/lib/logger';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { adminCorsHeaders } from '@/lib/admin-cors';

export async function OPTIONS() {
  return NextResponse.json({}, { headers: adminCorsHeaders(null) });
}

export async function POST(request: NextRequest) {
  // Impersonation is admin-only — support role cannot impersonate businesses
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: adminCorsHeaders(null) });
  }

  const supabase = createServiceClient();

  const body = await request.json();
  const { business_id, stepUpId } = body;

  if (!business_id) {
    return NextResponse.json({ error: 'Missing business_id' }, { status: 400, headers: adminCorsHeaders(null) });
  }

  // SEC-005 Layer 4: Consume operation-bound step-up authorization
  try {
    await consumeStepUp(admin, stepUpId, 'impersonate', business_id, { business_id });
  } catch (err) {
    const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
    return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403, headers: adminCorsHeaders(null) });
  }

  // Verify the business exists
  const { data: business } = await supabase
    .from('businesses')
    .select('id, name')
    .eq('id', business_id)
    .maybeSingle();

  if (!business) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404, headers: adminCorsHeaders(null) });
  }

  try {
    // Generate a 64-character hex token
    const token = randomBytes(32).toString('hex');

    // Insert token with 30-minute expiry
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const { error: insertError } = await supabase
      .from('admin_impersonation_tokens')
      .insert({
        admin_id: admin.id,
        business_id: business.id,
        token,
        expires_at: expiresAt.toISOString(),
      });

    if (insertError) {
      logger.error('Failed to create impersonation token:', insertError.message);
      return NextResponse.json({ error: 'Failed to create token' }, { status: 500, headers: adminCorsHeaders(null) });
    }

    // Log to impersonation_logs
    await supabase.from('impersonation_logs').insert({
      admin_id: admin.id,
      admin_email: admin.email || '',
      target_business_id: business.id,
      target_business_name: business.name,
      action: 'login_as_token_generated',
      changes: null,
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
    const url = `${appUrl}/dashboard/impersonate?token=${token}`;

    return NextResponse.json({ url }, { headers: adminCorsHeaders(null) });
  } catch (error) {
    logger.error('Impersonate token error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to generate impersonation token' }, { status: 500, headers: adminCorsHeaders(null) });
  }
}
