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

    // Extract provider-confirmed amount/currency from verified transaction
    const verifiedAmount = txData.amount as number | undefined;
    const verifiedCurrency = (txData.currency as string | undefined)?.toUpperCase();

    // Transaction verified as successful — look up the purchase
    const supabase = createServiceClient();

    const { data: purchase, error: lookupErr } = await supabase
      .from('messaging_topup_purchases')
      .select('id, status, package_amount_minor, currency_code')
      .eq('provider_reference', reference)
      .single();

    if (lookupErr || !purchase) {
      const { data: fallbackPurchase, error: fallbackErr } = await supabase
        .from('messaging_topup_purchases')
        .select('id, status, package_amount_minor, currency_code')
        .eq('provider_checkout_id', reference)
        .single();

      if (fallbackErr || !fallbackPurchase) {
        logger.warn('[TOPUP-CALLBACK] Purchase not found for reference', { reference });
        return NextResponse.redirect(new URL(`${dashboardBase}?topup=pending`, request.nextUrl.origin));
      }

      await supabase
        .from('messaging_topup_purchases')
        .update({ provider_reference: reference })
        .eq('id', fallbackPurchase.id)
        .is('provider_reference', null);

      if (fallbackPurchase.status === 'completed') {
        return NextResponse.redirect(new URL(`${dashboardBase}?topup=success`, request.nextUrl.origin));
      }

      // Fail-closed: provider amount/currency must match durable purchase
      if (verifiedAmount !== fallbackPurchase.package_amount_minor || verifiedCurrency !== fallbackPurchase.currency_code) {
        logger.error('[TOPUP-CALLBACK] amount/currency mismatch (fallback)', {
          purchaseId: fallbackPurchase.id, verifiedAmount, verifiedCurrency,
          purchaseAmount: fallbackPurchase.package_amount_minor, purchaseCurrency: fallbackPurchase.currency_code,
        });
        return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=amount_mismatch`, request.nextUrl.origin));
      }

      if (fallbackPurchase.status === 'pending') {
        const { data: grantResult, error: grantErr } = await supabase.rpc(
          'grant_purchased_messaging_allowance',
          { p_purchase_id: fallbackPurchase.id },
        );

        if (grantErr) {
          logger.error('[TOPUP-CALLBACK] Grant RPC error (fallback)', { purchaseId: fallbackPurchase.id, error: grantErr });
          return NextResponse.redirect(new URL(`${dashboardBase}?topup=pending`, request.nextUrl.origin));
        }

        if (grantResult?.granted) {
          logger.info('[TOPUP-CALLBACK] Grant succeeded (fallback)', { purchaseId: fallbackPurchase.id, idempotent: grantResult.idempotent ?? false });
          return NextResponse.redirect(new URL(`${dashboardBase}?topup=success`, request.nextUrl.origin));
        }
      }

      return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=grant_failed`, request.nextUrl.origin));
    }

    if (purchase.status === 'completed') {
      return NextResponse.redirect(new URL(`${dashboardBase}?topup=success`, request.nextUrl.origin));
    }

    if (purchase.status !== 'pending') {
      logger.warn('[TOPUP-CALLBACK] Purchase in non-grantable state', { purchaseId: purchase.id, status: purchase.status });
      return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=status_${purchase.status}`, request.nextUrl.origin));
    }

    // Fail-closed: provider amount/currency must match durable purchase
    if (verifiedAmount !== purchase.package_amount_minor || verifiedCurrency !== purchase.currency_code) {
      logger.error('[TOPUP-CALLBACK] amount/currency mismatch', {
        purchaseId: purchase.id, verifiedAmount, verifiedCurrency,
        purchaseAmount: purchase.package_amount_minor, purchaseCurrency: purchase.currency_code,
      });
      return NextResponse.redirect(new URL(`${dashboardBase}?topup=failed&reason=amount_mismatch`, request.nextUrl.origin));
    }

    const { data: grantResult, error: grantErr } = await supabase.rpc(
      'grant_purchased_messaging_allowance',
      { p_purchase_id: purchase.id },
    );

    if (grantErr) {
      logger.error('[TOPUP-CALLBACK] Grant RPC error', { purchaseId: purchase.id, error: grantErr });
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
