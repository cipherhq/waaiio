import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * Paystack redirect callback for messaging top-up payments (#491).
 *
 * After payment, Paystack redirects the user here with ?reference=xxx.
 * We verify the transaction with Paystack API, grant the allowance if
 * the purchase is still pending, and redirect to the billing page.
 *
 * This is idempotent — the RPC handles replay. The webhook will also
 * fire independently, so this is a belt-and-suspenders confirmation.
 */
export async function GET(request: NextRequest) {
  const reference = request.nextUrl.searchParams.get('reference');
  const dashboardBase = '/dashboard/billing';

  if (!reference) {
    return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=no_reference`, request.nextUrl.origin));
  }

  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) {
    logger.error('[TOPUP-CALLBACK] PAYSTACK_SECRET_KEY not configured');
    return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=config`, request.nextUrl.origin));
  }

  try {
    // Verify the transaction with Paystack
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${paystackKey}` },
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!verifyRes.ok) {
      logger.error('[TOPUP-CALLBACK] Paystack verification request failed', { reference, status: verifyRes.status });
      return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=verify_error`, request.nextUrl.origin));
    }

    const verifyBody = await verifyRes.json();
    const txData = verifyBody?.data;

    if (!txData || verifyBody.status !== true) {
      logger.error('[TOPUP-CALLBACK] Paystack verification response invalid', { reference, verifyStatus: verifyBody?.status });
      return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=verify_invalid`, request.nextUrl.origin));
    }

    if (txData.status !== 'success') {
      logger.warn('[TOPUP-CALLBACK] Paystack transaction not successful', { reference, txStatus: txData.status });
      return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=payment_${txData.status}`, request.nextUrl.origin));
    }

    // Transaction verified as successful — look up the purchase
    const supabase = createServiceClient();

    const { data: purchase, error: lookupErr } = await supabase
      .from('messaging_topup_purchases')
      .select('id, status')
      .eq('provider_reference', reference)
      .single();

    if (lookupErr || !purchase) {
      // The purchase might use provider_checkout_id instead, or the webhook hasn't set provider_reference yet.
      // Try looking up by provider_checkout_id as fallback.
      const { data: fallbackPurchase, error: fallbackErr } = await supabase
        .from('messaging_topup_purchases')
        .select('id, status')
        .eq('provider_checkout_id', reference)
        .single();

      if (fallbackErr || !fallbackPurchase) {
        logger.warn('[TOPUP-CALLBACK] Purchase not found for reference', { reference });
        // Redirect to success — the webhook will handle the grant asynchronously
        return NextResponse.redirect(new URL(`${dashboardBase}?topup=pending`, request.nextUrl.origin));
      }

      // Update provider_reference on the fallback match
      await supabase
        .from('messaging_topup_purchases')
        .update({ provider_reference: reference })
        .eq('id', fallbackPurchase.id)
        .is('provider_reference', null);

      if (fallbackPurchase.status === 'completed') {
        return NextResponse.redirect(new URL(`${dashboardBase}?topup=success`, request.nextUrl.origin));
      }

      if (fallbackPurchase.status === 'pending') {
        const { data: grantResult, error: grantErr } = await supabase.rpc(
          'grant_purchased_messaging_allowance',
          { p_purchase_id: fallbackPurchase.id },
        );

        if (grantErr) {
          logger.error('[TOPUP-CALLBACK] Grant RPC error (fallback)', { purchaseId: fallbackPurchase.id, error: grantErr });
          // Webhook will retry — redirect as pending
          return NextResponse.redirect(new URL(`${dashboardBase}?topup=pending`, request.nextUrl.origin));
        }

        if (grantResult?.granted) {
          logger.info('[TOPUP-CALLBACK] Grant succeeded (fallback)', { purchaseId: fallbackPurchase.id, idempotent: grantResult.idempotent ?? false });
          return NextResponse.redirect(new URL(`${dashboardBase}?topup=success`, request.nextUrl.origin));
        }
      }

      return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=grant_failed`, request.nextUrl.origin));
    }

    // Purchase found by provider_reference
    if (purchase.status === 'completed') {
      // Already completed (by webhook or prior callback) — success
      return NextResponse.redirect(new URL(`${dashboardBase}?topup=success`, request.nextUrl.origin));
    }

    if (purchase.status !== 'pending') {
      // Non-pending, non-completed (failed/refunded/disputed) — can't grant
      logger.warn('[TOPUP-CALLBACK] Purchase in non-grantable state', { purchaseId: purchase.id, status: purchase.status });
      return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=status_${purchase.status}`, request.nextUrl.origin));
    }

    // Purchase is pending — call the grant RPC
    const { data: grantResult, error: grantErr } = await supabase.rpc(
      'grant_purchased_messaging_allowance',
      { p_purchase_id: purchase.id },
    );

    if (grantErr) {
      logger.error('[TOPUP-CALLBACK] Grant RPC error', { purchaseId: purchase.id, error: grantErr });
      // Webhook will retry — redirect as pending
      return NextResponse.redirect(new URL(`${dashboardBase}?topup=pending`, request.nextUrl.origin));
    }

    if (grantResult?.granted) {
      logger.info('[TOPUP-CALLBACK] Grant succeeded', { purchaseId: purchase.id, idempotent: grantResult.idempotent ?? false });
      return NextResponse.redirect(new URL(`${dashboardBase}?topup=success`, request.nextUrl.origin));
    }

    logger.error('[TOPUP-CALLBACK] Grant not confirmed', { purchaseId: purchase.id, result: grantResult });
    return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=grant_failed`, request.nextUrl.origin));
  } catch (error) {
    logger.error('[TOPUP-CALLBACK] Unexpected error', { reference, error: String(error).slice(0, 500) });
    return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=error`, request.nextUrl.origin));
  }
}
