import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

/**
 * POST /api/auth/facebook/discover
 *
 * After Facebook Embedded Signup, exchange the auth code and discover
 * the WABA(s) and phone numbers shared with our app.
 * Returns the list so the user can select/confirm before finalizing.
 *
 * Body: { code: string }
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const { code, redirect_uri } = await request.json();

    if (!code) {
      return NextResponse.json(
        { message: 'Missing required field: code' },
        { status: 400 }
      );
    }

    const appId = (process.env.NEXT_PUBLIC_META_APP_ID || process.env.META_APP_ID || '').trim();
    const appSecret = (process.env.META_APP_SECRET || '').trim();

    if (!appId || !appSecret) {
      logger.error('Missing META_APP_ID or META_APP_SECRET env vars');
      return NextResponse.json(
        { message: 'Server configuration error' },
        { status: 500 }
      );
    }

    // 1. Exchange the authorization code for an access token
    let tokenUrl = `https://graph.facebook.com/v22.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${code}`;
    if (redirect_uri) {
      tokenUrl += `&redirect_uri=${encodeURIComponent(redirect_uri)}`;
    }
    const tokenRes = await fetch(tokenUrl);
    if (!tokenRes.ok) {
      const errData = await tokenRes.json().catch(() => ({}));
      logger.error('Code exchange failed:', errData, 'redirect_uri:', redirect_uri || 'none');
      return NextResponse.json(
        { message: 'Failed to exchange Facebook authorization code', error: errData, debug_redirect_uri: redirect_uri || 'none' },
        { status: 400 }
      );
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const tokenExpiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null;

    // 2. Use debug_token to discover which WABAs were shared
    const wabas: Array<{ id: string; name: string }> = [];

    const debugRes = await fetch(
      `https://graph.facebook.com/v22.0/debug_token?input_token=${accessToken}&access_token=${appId}|${appSecret}`
    );
    if (debugRes.ok) {
      const debugData = await debugRes.json();
      const scopes = debugData.data?.granular_scopes || [];
      const wabaScope = scopes.find(
        (s: any) => s.scope === 'whatsapp_business_management' && s.target_ids?.length > 0
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
      try {
        const phonesRes = await fetch(
          `https://graph.facebook.com/v22.0/${waba.id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (phonesRes.ok) {
          const phonesData = await phonesRes.json();
          wabaPhones.push({
            waba_id: waba.id,
            waba_name: waba.name,
            phones: phonesData.data || [],
          });
        } else {
          wabaPhones.push({
            waba_id: waba.id,
            waba_name: waba.name,
            phones: [],
          });
        }
      } catch {
        wabaPhones.push({
          waba_id: waba.id,
          waba_name: waba.name,
          phones: [],
        });
      }
    }

    return NextResponse.json({
      access_token: accessToken,
      token_expires_at: tokenExpiresAt,
      wabas: wabaPhones,
    });
  } catch (error) {
    logger.error('Facebook discover error:', error);
    return NextResponse.json(
      { message: 'Internal server error', error: (error as Error).message },
      { status: 500 }
    );
  }
}
