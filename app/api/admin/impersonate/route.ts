import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { randomBytes } from 'crypto';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify admin or support role
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !['admin', 'support'].includes(profile.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { business_id } = body;

  if (!business_id) {
    return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });
  }

  // Verify the business exists
  const { data: business } = await supabase
    .from('businesses')
    .select('id, name')
    .eq('id', business_id)
    .maybeSingle();

  if (!business) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  try {
    // Generate a 64-character hex token
    const token = randomBytes(32).toString('hex');

    // Insert token with 30-minute expiry
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const { error: insertError } = await supabase
      .from('admin_impersonation_tokens')
      .insert({
        admin_id: user.id,
        business_id: business.id,
        token,
        expires_at: expiresAt.toISOString(),
      });

    if (insertError) {
      logger.error('Failed to create impersonation token:', insertError.message);
      return NextResponse.json({ error: 'Failed to create token' }, { status: 500 });
    }

    // Log to impersonation_logs
    await supabase.from('impersonation_logs').insert({
      admin_id: user.id,
      admin_email: user.email || '',
      target_business_id: business.id,
      target_business_name: business.name,
      action: 'login_as_token_generated',
      changes: null,
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
    const url = `${appUrl}/dashboard/impersonate?token=${token}`;

    return NextResponse.json({ url });
  } catch (error) {
    logger.error('Impersonate token error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to generate impersonation token' }, { status: 500 });
  }
}
