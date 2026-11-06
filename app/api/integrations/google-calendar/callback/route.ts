import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { exchangeGoogleCode } from '@/lib/integrations/google-calendar';
import {
  gcalNonceCookieOptions,
  GCAL_NONCE_COOKIE,
  verifyGoogleCalendarState,
} from '@/lib/integrations/google-calendar-oauth-state';
import { logger } from '@/lib/logger';

const SETTINGS_PATH = '/dashboard/integrations';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state'); // signed state from the start route
  const error = searchParams.get('error');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

  // Relative, validated redirect; the nonce cookie is always cleared.
  const redirectTo = (path: string) => {
    const safePath = path.startsWith('/') && !path.startsWith('//') ? path : SETTINGS_PATH;
    const response = NextResponse.redirect(`${appUrl}${safePath}`);
    response.cookies.set(GCAL_NONCE_COOKIE, '', gcalNonceCookieOptions(0));
    return response;
  };

  if (error) {
    return redirectTo(`${SETTINGS_PATH}?error=google_denied`);
  }

  if (!code || !state) {
    return redirectTo(`${SETTINGS_PATH}?error=missing_params`);
  }

  const supabase = await createClient();

  // Every check runs before the code exchange or any write.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return redirectTo(`${SETTINGS_PATH}?error=callback_failed`);
  }

  const verified = verifyGoogleCalendarState(state, {
    userId: user.id,
    cookieNonce: request.cookies.get(GCAL_NONCE_COOKIE)?.value,
  });
  if (!verified) {
    logger.warn('[GCAL] Rejected callback: state did not verify');
    return redirectTo(`${SETTINGS_PATH}?error=callback_failed`);
  }

  // Business id comes only from the verified payload; re-check ownership now.
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', verified.businessId)
    .eq('owner_id', user.id)
    .single();
  if (!biz) {
    return redirectTo(`${SETTINGS_PATH}?error=callback_failed`);
  }

  const businessId = biz.id;

  try {
    const redirectUri = `${appUrl}/api/integrations/google-calendar/callback`;
    const tokens = await exchangeGoogleCode(code, redirectUri);

    if (!tokens) {
      return redirectTo(`${SETTINGS_PATH}?error=token_exchange_failed`);
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
    return redirectTo(`${SETTINGS_PATH}?google_calendar=connected`);
  } catch (err) {
    logger.error('[GCAL] Callback error:', err);
    return redirectTo(`${SETTINGS_PATH}?error=callback_failed`);
  }
}
