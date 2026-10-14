import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

const ALLOWED_PAYOUT_MODES = ['direct_split', 'platform_managed'] as const;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { business_id, payout_mode, terms_version } = body;

  if (!business_id || !payout_mode) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  if (!ALLOWED_PAYOUT_MODES.includes(payout_mode as typeof ALLOWED_PAYOUT_MODES[number])) {
    return NextResponse.json({ error: 'Invalid payout mode' }, { status: 400 });
  }

  // Verify the user owns this business (session client respects RLS)
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found or not owned by you' }, { status: 403 });
  }

  const serviceClient = createServiceClient();

  try {
    // Record terms acceptance (session client — RLS scoped)
    const { error: termsError } = await supabase
      .from('payout_terms_acceptance')
      .insert({
        business_id,
        accepted_by: user.id,
        terms_version: terms_version || '1.0',
        payout_mode,
        ip_address: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null,
      });

    if (termsError) {
      logger.error('Insert terms acceptance error:', termsError);
      return NextResponse.json({ error: 'Failed to record terms acceptance' }, { status: 500 });
    }

    // Update business payout mode via service client (guarded column)
    const { error: updateError } = await serviceClient
      .from('businesses')
      .update({ payout_mode })
      .eq('id', business_id);

    if (updateError) {
      logger.error('Update payout mode error:', updateError);
      return NextResponse.json({ error: 'Failed to update payout mode' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Accept terms error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to accept terms' }, { status: 500 });
  }
}
