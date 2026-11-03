import { listSignupPhones } from '@/lib/whatsapp/embedded-signup-assets';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { assertSignupSessionConfigured, createSignupSession } from '@/lib/whatsapp/embedded-signup-session';
import { logger } from '@/lib/logger';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';

/**
 * POST /api/auth/facebook/discover
 *
 * After Facebook Embedded Signup, exchange the auth code and discover
 * the WABA(s) and phone numbers shared with our app.
 * Returns the list so the user can select/confirm before finalizing.
 *
 * Body: { code: string, business_id: string }
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ message: 'Invalid request origin' }, { status: 403 });
  }
  const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'fb-discover'), 5, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const { code, business_id, access_token } = await request.json();
    if (typeof code !== 'string' || !code || typeof business_id !== 'string' || !business_id || access_token) {
      return NextResponse.json({ message: 'An authorization code and business are required.' }, { status: 400 });
    }
    const { data: business, error: businessError } = await supabase.from('businesses')
      .select('owner_id').eq('id', business_id).single();
    if (businessError || !business || business.owner_id !== user.id) {
      return NextResponse.json({ message: 'Business not found or not owned by you' }, { status: 403 });
    }
    assertSignupSessionConfigured();

    const appId = (process.env.NEXT_PUBLIC_META_APP_ID || process.env.META_APP_ID || '').trim();
    const appSecret = (process.env.META_APP_SECRET || '').trim();

    if (!appId || !appSecret) {
      logger.error('Missing META_APP_ID or META_APP_SECRET env vars');
      return NextResponse.json(
        { message: 'Server configuration error' },
        { status: 500 }
      );
    }

    const tokenUrl = new URL('https://graph.facebook.com/v22.0/oauth/access_token');
    tokenUrl.search = new URLSearchParams({ client_id: appId, client_secret: appSecret, code }).toString();
    const tokenRes = await fetch(tokenUrl.toString(), { cache: 'no-store' });
    if (!tokenRes.ok) {
      return NextResponse.json({ message: 'Failed to exchange Facebook authorization code. Please reconnect with Meta.' }, { status: 400 });
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (typeof accessToken !== 'string' || !accessToken) throw new Error('Missing provider token');
    let tokenExpiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null;

    // 2. Use debug_token to discover which WABAs were shared
    const wabas: Array<{ id: string; name: string }> = [];

    const debugRes = await fetch(
      `https://graph.facebook.com/v22.0/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`
    );
    if (debugRes.ok) {
      const debugData = await debugRes.json();
      if (!debugData.data?.is_valid || String(debugData.data.app_id) !== appId) {
        return NextResponse.json({ message: 'Meta authorization does not match this application. Please reconnect.' }, { status: 403 });
      }
      if (debugData.data.expires_at) tokenExpiresAt = new Date(debugData.data.expires_at * 1000).toISOString();
      if (tokenExpiresAt && Date.parse(tokenExpiresAt) <= Date.now()) {
        return NextResponse.json({ message: 'Meta authorization expired. Please reconnect.' }, { status: 403 });
      }
      const scopes = debugData.data?.granular_scopes || [];
      const wabaScope = scopes.find(
        (s: { scope?: string; permission?: string; target_ids?: string[] }) => (s.scope || s.permission) === 'whatsapp_business_management' && (s.target_ids?.length ?? 0) > 0
      );
      if (wabaScope) {
        for (const wabaId of wabaScope.target_ids) {
          // Fetch WABA name
          let wabaName = wabaId;
          try {
            const wabaRes = await fetch(
              `https://graph.facebook.com/v22.0/${wabaId}?fields=id,name`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            if (wabaRes.ok) {
              const wabaData = await wabaRes.json();
              wabaName = wabaData.name || wabaId;
            }
          } catch {
            // Use the ID as fallback
          }
          wabas.push({ id: wabaId, name: wabaName });
        }
      }
    }

    if (wabas.length === 0) {
      return NextResponse.json(
        { message: 'No WhatsApp Business Account found. Please complete the Facebook signup flow.' },
        { status: 400 }
      );
    }

    // 3. Fetch phone numbers for each WABA
    const wabaPhones: Array<{
      waba_id: string;
      waba_name: string;
      phones: Array<{
        id: string;
        display_phone_number: string;
        verified_name: string;
        quality_rating: string;
      }>;
    }> = [];

    for (const waba of wabas) {
      wabaPhones.push({ waba_id: waba.id, waba_name: waba.name, phones: await listSignupPhones(waba.id, accessToken) });
    }

    return NextResponse.json({
      connection_id: await createSignupSession(user.id, business_id, { accessToken, tokenExpiresAt, accounts: wabaPhones }),
      wabas: wabaPhones,
    });
  } catch (error) {
    logger.error('Facebook discovery failed');
    return NextResponse.json(
      { message: 'Something went wrong' },
      { status: 500 }
    );
  }
}
