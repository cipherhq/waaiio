import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { exchangeGoogleCode } from '@/lib/integrations/google-calendar';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state'); // business_id
  const error = searchParams.get('error');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

  if (error) {
    return NextResponse.redirect(`${appUrl}/dashboard/integrations?error=google_denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${appUrl}/dashboard/integrations?error=missing_params`);
  }

  const businessId = state;
  const supabase = await createClient();

  try {
    const redirectUri = `${appUrl}/api/integrations/google-calendar/callback`;
    const tokens = await exchangeGoogleCode(code, redirectUri);

    if (!tokens) {
      return NextResponse.redirect(`${appUrl}/dashboard/integrations?error=token_exchange_failed`);
    }

    await supabase
      .from('businesses')
      .update({
        google_calendar_token: tokens.access_token,
        google_calendar_refresh_token: tokens.refresh_token,
        google_calendar_id: 'primary',
      })
      .eq('id', businessId);

    logger.debug('[GCAL] Connected Google Calendar for business:', businessId);
    return NextResponse.redirect(`${appUrl}/dashboard/integrations?google_calendar=connected`);
  } catch (err) {
    logger.error('[GCAL] Callback error:', err);
    return NextResponse.redirect(`${appUrl}/dashboard/integrations?error=callback_failed`);
  }
}
