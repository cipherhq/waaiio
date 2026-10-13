import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { business_id, password } = body;

  if (!business_id) {
    return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });
  }

  // Re-authentication required
  if (!password || typeof password !== 'string') {
    return NextResponse.json({ error: 'Password required to disconnect payout account' }, { status: 403 });
  }

  if (!user.email) {
    return NextResponse.json({ error: 'User email not found' }, { status: 400 });
  }

  const { error: authError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password,
  });
  if (authError) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 403 });
  }

  // Verify the user owns this business (session client enforces RLS)
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  const service = createServiceClient();

  try {
    // Deactivate payout account (service client)
    const { error: deactivateError } = await service
      .from('payout_accounts')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('business_id', business_id)
      .eq('is_active', true);

    if (deactivateError) {
      logger.error('Deactivate payout account error:', deactivateError);
      return NextResponse.json({ error: 'Failed to deactivate payout account' }, { status: 500 });
    }

    // Reset business payout mode (service client)
    const { error: modeError } = await service
      .from('businesses')
      .update({ payout_mode: 'platform_managed' })
      .eq('id', business_id);

    if (modeError) {
      logger.error('Reset payout mode error:', modeError);
      // Account already deactivated — report partial failure
      return NextResponse.json({ error: 'Account deactivated but failed to reset payout mode' }, { status: 500 });
    }

    // Send notification email
    sendEmail({
      to: user.email!,
      subject: `Payout account disconnected — ${biz.name}`,
      html: `<p>The payout account for <strong>${biz.name}</strong> has been disconnected.</p><p>Payments will be held until a new account is connected.</p><p>If this wasn't you, contact support immediately.</p>`,
    }).catch(e => logger.error('Failed to send disconnect notification:', e));

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Disconnect payout error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to disconnect payout account' }, { status: 500 });
  }
}
