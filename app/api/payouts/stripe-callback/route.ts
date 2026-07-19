import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import type { SupabaseClient } from '@supabase/supabase-js';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';

/** Restore previously revoked connections if the replacement insert fails */
async function restoreRevokedConns(
  service: SupabaseClient,
  snapshot: Array<{ id: string; is_active: boolean; connection_status: string; is_default: boolean }> | null,
) {
  if (!snapshot?.length) return;
  for (const conn of snapshot) {
    await service.from('payout_accounts').update({
      is_active: conn.is_active,
      connection_status: conn.connection_status,
      is_default: conn.is_default,
      updated_at: new Date().toISOString(),
    }).eq('id', conn.id);
  }
  logger.info('[STRIPE-CALLBACK] Restored', snapshot.length, 'previously revoked connection(s)');
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

  // Validate cryptographic OAuth state
  const state = searchParams.get('state');
  if (!state) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=missing_state`);
  }

  const { verifyOAuthState, consumeOAuthState } = await import('@/lib/payments/oauth-state');
  const { createServiceClient } = await import('@/lib/supabase/service');
  const verified = verifyOAuthState(state);
  if (!verified) {
    logger.warn('[STRIPE-CALLBACK] Invalid, expired, or tampered state parameter');
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=invalid_state`);
  }

  // Consume nonce atomically — prevents replay.
  // Returns the stored state payload (from DB), not just a boolean.
  const service = createServiceClient();
  let consumed;
  try {
    consumed = await consumeOAuthState(service, verified.nonce);
  } catch (err) {
    logger.error('[STRIPE-CALLBACK] OAuth state consumption error:', (err as Error).message);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=state_error`);
  }
  if (!consumed) {
    logger.warn('[STRIPE-CALLBACK] State already consumed (replay attempt)');
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=state_replayed`);
  }

  // Use the DB-stored payload (authoritative), not just the signed token
  const { userId, businessId, accountId } = consumed;

  // Validate token bindings match DB state
  if (consumed.provider !== 'stripe') {
    logger.warn('[STRIPE-CALLBACK] Provider mismatch: expected stripe, got', consumed.provider);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=provider_mismatch`);
  }

  // Verify the authenticated user matches the state
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== userId) {
    logger.warn('[STRIPE-CALLBACK] Authenticated user does not match state');
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=user_mismatch`);
  }

  // Verify business ownership via authenticated client (RLS-enforced)
  const { data: bizCheck } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .single();
  if (!bizCheck) {
    logger.warn('[STRIPE-CALLBACK] User does not own business', businessId);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_owner`);
  }

  // All mutations below use service client (bypasses sensitive-field trigger).
  // Auth check above proves ownership; service client is safe here.
  try {
    if (!stripeSecretKey) {
      // Mock mode — snapshot, revoke, insert with restore-on-failure
      const { data: mockOldConns } = await service.from('payout_accounts')
        .select('id, is_active, connection_status, is_default')
        .eq('business_id', businessId).eq('gateway', 'stripe').eq('is_active', true);

      const { error: revokeErr } = await service.from('payout_accounts')
        .update({ is_active: false, connection_status: 'revoked', updated_at: new Date().toISOString() })
        .eq('business_id', businessId).eq('gateway', 'stripe').eq('is_active', true);

      if (revokeErr) {
        logger.error('[STRIPE-CALLBACK] Mock revoke error:', revokeErr.message);
        return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=revoke_failed`);
      }

      const { data: mockDefault, error: mockDefaultErr } = await service.from('payout_accounts')
        .select('id').eq('business_id', businessId).eq('is_default', true)
        .eq('is_active', true).not('verified_at', 'is', null).maybeSingle();

      if (mockDefaultErr) {
        logger.error('[STRIPE-CALLBACK] Mock default query error:', mockDefaultErr.message);
        await restoreRevokedConns(service, mockOldConns);
        return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=default_query_failed`);
      }

      const { error: mockInsertErr } = await service.from('payout_accounts').insert({
        business_id: businessId, gateway: 'stripe', stripe_account_id: accountId,
        platform_percentage: 2.5, is_active: true, is_default: !mockDefault,
        connection_mode: 'connect', connection_status: 'active',
        health_status: 'healthy', verified_at: new Date().toISOString(),
      });

      if (mockInsertErr) {
        logger.error('[STRIPE-CALLBACK] Mock insert error:', mockInsertErr.message);
        await restoreRevokedConns(service, mockOldConns);
        return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=insert_failed`);
      }

      return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
    }

    // Verify the account status with Stripe
    const res = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    });
    const account = await res.json();

    if (!account.charges_enabled) {
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_verified`);
    }

    // Snapshot existing Stripe connections before revoking so we can restore on failure
    const { data: oldStripeConns } = await service
      .from('payout_accounts')
      .select('id, is_active, connection_status, is_default')
      .eq('business_id', businessId)
      .eq('gateway', 'stripe')
      .eq('is_active', true);

    // Deactivate only previous Stripe connections (preserve other providers)
    const { error: revokeErr } = await service
      .from('payout_accounts')
      .update({ is_active: false, connection_status: 'revoked', updated_at: new Date().toISOString() })
      .eq('business_id', businessId)
      .eq('gateway', 'stripe')
      .eq('is_active', true);

    if (revokeErr) {
      logger.error('[STRIPE-CALLBACK] Revoke error:', revokeErr.message);
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=revoke_failed`);
    }

    // Check if business has an existing valid default (from any provider)
    const { data: existingDefault, error: defaultQueryErr } = await service
      .from('payout_accounts')
      .select('id')
      .eq('business_id', businessId)
      .eq('is_default', true)
      .eq('is_active', true)
      .not('verified_at', 'is', null)
      .maybeSingle();

    if (defaultQueryErr) {
      logger.error('[STRIPE-CALLBACK] Default query error:', defaultQueryErr.message);
      // Restore revoked connections and abort
      await restoreRevokedConns(service, oldStripeConns);
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=default_query_failed`);
    }

    // Save the connected account (service client — sets sensitive fields)
    const { error: insertErr } = await service.from('payout_accounts').insert({
      business_id: businessId,
      gateway: 'stripe',
      stripe_account_id: accountId,
      platform_percentage: 2.5,
      is_active: true,
      is_default: !existingDefault, // Default only if no existing valid default
      connection_mode: 'connect',
      connection_status: 'active',
      health_status: 'healthy',
      verified_at: new Date().toISOString(),
    });

    if (insertErr) {
      logger.error('[STRIPE-CALLBACK] Insert error:', insertErr.message);
      // Restore revoked connections — don't leave business without its prior Stripe
      await restoreRevokedConns(service, oldStripeConns);
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=insert_failed`);
    }

    // Auto-set payout_mode to direct_split
    const { error: bizUpdateErr } = await service
      .from('businesses')
      .update({ payout_mode: 'direct_split' })
      .eq('id', businessId);

    if (bizUpdateErr) {
      logger.error('[STRIPE-CALLBACK] Business update error:', bizUpdateErr.message);
      // Non-fatal — connection was created successfully
    }

    return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
  } catch (error) {
    logger.error('Stripe callback error:', (error as Error).message);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=callback_failed`);
  }
}
