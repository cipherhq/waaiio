import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { encryptToken, decryptToken } from '@/lib/encryption';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/cron/refresh-meta-tokens
 *
 * Refreshes Meta Cloud API access tokens before they expire.
 * Runs daily at 3 AM UTC. Proactively refreshes tokens expiring within 14 days.
 *
 * Meta long-lived tokens last ~60 days. This cron exchanges them for new
 * long-lived tokens using the fb_exchange_token grant type.
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    logger.error('[refresh-meta-tokens] META_APP_ID or META_APP_SECRET not configured');
    return NextResponse.json(
      { ok: false, error: 'Meta app credentials not configured' },
      { status: 500 }
    );
  }

  const supabase = createServiceClient();

  // Calculate the cutoff: 14 days from now
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 14);

  // Find channels with tokens expiring within 14 days
  const { data: channels, error: queryError } = await supabase
    .from('whatsapp_channels')
    .select('id, business_id, meta_access_token, meta_token_expires_at')
    .eq('provider', 'meta_cloud')
    .eq('is_active', true)
    .not('meta_access_token', 'is', null)
    .lte('meta_token_expires_at', cutoff.toISOString());

  if (queryError) {
    logger.error('[refresh-meta-tokens] Failed to query channels', { error: queryError.message });
    return NextResponse.json(
      { ok: false, error: 'Failed to query channels' },
      { status: 500 }
    );
  }

  if (!channels || channels.length === 0) {
    logger.info('[refresh-meta-tokens] No tokens need refreshing');
    return NextResponse.json({ ok: true, processed: 0, refreshed: 0, errors: 0 });
  }

  let refreshed = 0;
  let errors = 0;

  // Process sequentially to respect Meta's rate limits (~200 calls/hour)
  for (const channel of channels) {
    try {
      // Decrypt the existing token
      const currentToken = decryptToken(channel.meta_access_token);

      // Exchange for a new long-lived token
      const url = new URL('https://graph.facebook.com/v22.0/oauth/access_token');
      url.searchParams.set('grant_type', 'fb_exchange_token');
      url.searchParams.set('client_id', appId);
      url.searchParams.set('client_secret', appSecret);
      url.searchParams.set('fb_exchange_token', currentToken);

      const response = await fetch(url.toString());
      const data = await response.json();

      if (!response.ok || data.error) {
        const errorMsg = data.error?.message || `HTTP ${response.status}`;
        logger.error('[refresh-meta-tokens] Meta API error', {
          channelId: channel.id,
          businessId: channel.business_id,
          error: errorMsg,
        });
        errors++;
        continue;
      }

      if (!data.access_token) {
        logger.error('[refresh-meta-tokens] No access_token in response', {
          channelId: channel.id,
          businessId: channel.business_id,
        });
        errors++;
        continue;
      }

      // Calculate new expiry from the expires_in field (seconds)
      const expiresAt = new Date();
      if (data.expires_in) {
        expiresAt.setSeconds(expiresAt.getSeconds() + data.expires_in);
      } else {
        // Default to 60 days if expires_in not provided
        expiresAt.setDate(expiresAt.getDate() + 60);
      }

      // Encrypt and store the new token
      const encryptedToken = encryptToken(data.access_token);

      const { error: updateError } = await supabase
        .from('whatsapp_channels')
        .update({
          meta_access_token: encryptedToken,
          meta_token_expires_at: expiresAt.toISOString(),
        })
        .eq('id', channel.id);

      if (updateError) {
        logger.error('[refresh-meta-tokens] Failed to update channel', {
          channelId: channel.id,
          businessId: channel.business_id,
          error: updateError.message,
        });
        errors++;
        continue;
      }

      logger.info('[refresh-meta-tokens] Token refreshed', {
        channelId: channel.id,
        businessId: channel.business_id,
        expiresAt: expiresAt.toISOString(),
      });
      refreshed++;
    } catch (err) {
      logger.error('[refresh-meta-tokens] Unexpected error', {
        channelId: channel.id,
        businessId: channel.business_id,
        error: err instanceof Error ? err.message : String(err),
      });
      errors++;
    }
  }

  logger.info('[refresh-meta-tokens] Completed', {
    processed: channels.length,
    refreshed,
    errors,
  });

  return NextResponse.json({
    ok: true,
    processed: channels.length,
    refreshed,
    errors,
  });
}
