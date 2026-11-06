import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  createGoogleCalendarState,
  gcalNonceCookieOptions,
  GCAL_NONCE_COOKIE,
  GCAL_STATE_TTL_SECONDS,
} from '@/lib/integrations/google-calendar-oauth-state';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || '';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { business_id } = await request.json();
  if (!business_id) return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });

  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  if (!GOOGLE_CLIENT_ID) {
    return NextResponse.json({ error: 'Google Calendar not configured' }, { status: 500 });
  }

  // Signed state bound to this user, business and a cookie nonce (checked in the callback).
  const signed = createGoogleCalendarState(user.id, biz.id);
  if (!signed) {
    return NextResponse.json({ error: 'Google Calendar not configured' }, { status: 500 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  const redirectUri = `${appUrl}/api/integrations/google-calendar/callback`;

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    access_type: 'offline',
    prompt: 'consent',
    state: signed.state,
  });

  const response = NextResponse.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  response.cookies.set(GCAL_NONCE_COOKIE, signed.nonce, gcalNonceCookieOptions(GCAL_STATE_TTL_SECONDS));
  return response;
}
