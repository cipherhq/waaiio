import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { PaymentGateway, InitPaymentOpts, InitPaymentResult, RefundPaymentOpts, RefundResult } from './types';
import { logger } from '@/lib/logger';

const squareAccessToken = process.env.SQUARE_ACCESS_TOKEN || '';
const squareLocationId = process.env.SQUARE_LOCATION_ID || '';
const squareEnvironment = process.env.SQUARE_ENVIRONMENT || 'sandbox';

function getSquareBaseUrl(): string {
  return squareEnvironment === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

async function squareRequest(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${getSquareBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Square-Version': '2024-12-18',
      Authorization: `Bearer ${squareAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

async function squareGet(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${getSquareBaseUrl()}${path}`, {
    headers: {
      'Square-Version': '2024-12-18',
      Authorization: `Bearer ${squareAccessToken}`,
    },
    signal: AbortSignal.timeout(15000),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

export class SquareGateway implements PaymentGateway {
  name = 'square' as const;

  async initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null> {
    // Validate positive amount
    if (!opts.amount || opts.amount <= 0) {
      logger.error('[SQUARE] Invalid payment amount:', opts.amount);
      return null;
    }

    // Validate fee bounds
    if (opts.platformFeeAmount != null && opts.platformFeeAmount < 0) {
      logger.error('[SQUARE] Negative platform fee');
      return null;
    }
    if (opts.platformFeeAmount != null && opts.platformFeeAmount >= opts.amount) {
      logger.error('[SQUARE] Platform fee exceeds payment amount');
      return null;
    }

    try {
      // Mock mode: only when NEITHER platform nor connected seller token exists
      const hasAnyToken = squareAccessToken || opts.squareAccessToken;
      if (!hasAnyToken) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('Payment gateway not configured: no Square access token');
        }
        const mockRef = `mock_square_${randomUUID()}`;
        await opts.supabase.from('payments').insert({
          booking_id: opts.bookingId || null,
          invoice_id: opts.invoiceId || null,
          campaign_id: opts.campaignId || null,
          reservation_id: opts.reservationId || null,
          business_id: opts.businessId || null,
          user_id: opts.userId,
          amount: opts.amount,
          currency: opts.currency,
          gateway: 'square',
          gateway_reference: mockRef,
          status: 'pending',
          collection_mode: opts.collectionMode || 'platform',
          fee_bearer: opts.feeBearerMode || 'platform',
          payout_account_id: opts.payoutAccountId || null,
          waaiio_fee: opts.waaiioFee ?? 0,
          metadata: { reference_code: opts.referenceCode, channel: 'whatsapp', order_id: opts.orderId || null },
        });
        const { getAppUrl } = await import('@/lib/get-app-url');
        return { url: `${getAppUrl()}/pay?ref=${mockRef}`, reference: mockRef };
      }

      const amountInCents = Math.round(opts.amount * 100);
      const { getAppUrl } = await import('@/lib/get-app-url');
      const useToken = opts.squareAccessToken || squareAccessToken;
      const useLocation = opts.squareLocationId || squareLocationId;

      // Step 1: Create or recover the payment attempt row.
      // Uses an immutable payment_attempt_key for retry recovery.
      // This key survives gateway_reference overwrites and is scoped by
      // gateway + business + reference_code to prevent cross-tenant collisions.
      const attemptKey = `square:${opts.businessId || 'platform'}:${opts.referenceCode}`;
      let paymentId: string;
      let insertShortRef: string = randomUUID(); // Generated once, persisted atomically at insert

      // Check for existing attempt (retry recovery) via the immutable key
      const { data: existingAttempt } = await opts.supabase.from('payments')
        .select('id, gateway_reference, metadata')
        .eq('payment_attempt_key', attemptKey)
        .maybeSingle();

      if (existingAttempt) {
        paymentId = existingAttempt.id;
        const existingMeta = existingAttempt.metadata as Record<string, unknown> | null;
        // Recover the shortRef from the existing row
        if (existingMeta?.checkout_short_ref) {
          insertShortRef = existingMeta.checkout_short_ref as string;
        }
        // If Square already succeeded (checkout URL stored), return without re-calling Square
        if (existingMeta?.square_checkout_url && existingMeta?.square_payment_link_id) {
          return {
            url: existingMeta.square_checkout_url as string,
            reference: paymentId,
            shortRef: insertShortRef,
          };
        }
      } else {
        // First attempt: create the payment row with the immutable attempt key
        const { data: newPayment, error: insertErr } = await opts.supabase.from('payments').insert({
          booking_id: opts.bookingId || null,
          invoice_id: opts.invoiceId || null,
          campaign_id: opts.campaignId || null,
          reservation_id: opts.reservationId || null,
          business_id: opts.businessId || null,
          user_id: opts.userId,
          amount: opts.amount,
          currency: opts.currency,
          gateway: 'square',
          gateway_reference: `sq-init-${opts.referenceCode}`,
          payment_attempt_key: attemptKey,
          status: 'pending',
          collection_mode: opts.collectionMode || 'platform',
          fee_bearer: opts.feeBearerMode || 'platform',
          payout_account_id: opts.payoutAccountId || null,
          waaiio_fee: opts.waaiioFee ?? 0,
          metadata: {
            reference_code: opts.referenceCode,
            channel: 'whatsapp',
            order_id: opts.orderId || null,
            checkout_short_ref: insertShortRef,
          },
        }).select('id').single();

        if (insertErr || !newPayment) {
          // Unique violation on attempt_key means another concurrent call created it
          if (insertErr?.code === '23505') {
            const { data: concurrent } = await opts.supabase.from('payments')
              .select('id, metadata').eq('payment_attempt_key', attemptKey).single();
            if (concurrent) {
              paymentId = concurrent.id;
              // Use the winner's shortRef
              const concurrentMeta = concurrent.metadata as Record<string, unknown> | null;
              if (concurrentMeta?.checkout_short_ref) {
                insertShortRef = concurrentMeta.checkout_short_ref as string;
              }
            } else {
              return null;
            }
          } else {
            logger.error('[SQUARE] Payment row creation failed:', insertErr?.message);
            return null;
          }
        } else {
          paymentId = newPayment.id;
        }
      }

      // Step 2: Use the payment row ID as the stable idempotency key
      const idempotencyKey = paymentId;

      const paymentLinkBody: Record<string, unknown> = {
        idempotency_key: idempotencyKey,
        quick_pay: {
          name: `${opts.businessName} - ${opts.referenceCode}`,
          price_money: { amount: amountInCents, currency: opts.currency.toUpperCase() },
          location_id: useLocation,
        },
        checkout_options: {
          redirect_url: `${getAppUrl()}/payment-success?paymentId=${paymentId}`,
          accepted_payment_methods: { cash_app_pay: true, apple_pay: true, google_pay: true },
        },
        pre_populated_data: {
          buyer_email: opts.userEmail || undefined,
          buyer_phone_number: opts.phone || undefined,
        },
      };

      if (opts.squareMerchantId && opts.platformFeeAmount) {
        const feeInCents = Math.round(opts.platformFeeAmount * 100);
        (paymentLinkBody.checkout_options as Record<string, unknown>).app_fee_money = {
          amount: feeInCents, currency: opts.currency.toUpperCase(),
        };
      }

      const requestFn = opts.squareAccessToken
        ? async (path: string, body: Record<string, unknown>) => {
            const response = await fetch(`${getSquareBaseUrl()}${path}`, {
              method: 'POST',
              headers: {
                'Square-Version': '2024-12-18',
                Authorization: `Bearer ${opts.squareAccessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(15000),
            });
            return response.json() as Promise<Record<string, unknown>>;
          }
        : squareRequest;

      const result = await requestFn('/v2/online-checkout/payment-links', paymentLinkBody);

      const paymentLink = result.payment_link as Record<string, unknown> | undefined;
      if (!paymentLink?.id || !paymentLink?.url) {
        // Do NOT delete the payment row on ambiguous outcomes (timeout, 5xx, malformed response).
        // Square may have accepted the request. Preserve the row for retry recovery.
        // Only a definitive error response (4xx with clear rejection) would be safe to clean up,
        // but we keep the row regardless for safety — it will be recoverable on retry.
        logger.error('[SQUARE] Payment link creation failed or ambiguous response');
        return null;
      }

      const squareRef = paymentLink.id as string;
      const orderId = paymentLink.order_id as string | undefined;

      // Step 3: Update the payment row with Square's actual references
      // Store the checkout URL and short ref in metadata for retry recovery
      const { error: updateErr } = await opts.supabase.from('payments').update({
        gateway_reference: squareRef,
        provider_order_ref: orderId || null,
        metadata: {
          square_payment_link_id: squareRef,
          square_order_id: orderId || null,
          square_checkout_url: paymentLink.url as string,
          checkout_short_ref: insertShortRef,
          reference_code: opts.referenceCode,
          channel: 'whatsapp',
          order_id: opts.orderId || null,
        },
      }).eq('id', paymentId);

      if (updateErr) {
        logger.error('[SQUARE] Payment row update failed:', updateErr.message);
        return null;
      }

      if (opts.bookingId) {
        await opts.supabase.from('bookings').update({ payment_id: paymentId }).eq('id', opts.bookingId);
      }
      if (opts.invoiceId) {
        await opts.supabase.from('invoices').update({ payment_id: paymentId }).eq('id', opts.invoiceId);
      }

      return { url: paymentLink.url as string, reference: paymentId, shortRef: insertShortRef };
    } catch (error) {
      logger.error('[SQUARE] init error:', (error as Error).message);
      return null;
    }
  }

  async verifyPayment(supabase: SupabaseClient, reference: string, byoSecretKey?: string): Promise<boolean> {
    const hasToken = squareAccessToken || byoSecretKey;
    if (!hasToken || reference.startsWith('mock_')) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Payment gateway not configured: no Square access token');
      }
      await supabase
        .from('payments')
        .update({ status: 'success', paid_at: new Date().toISOString() })
        .eq('gateway_reference', reference);

      const { data: payment } = await supabase
        .from('payments')
        .select('booking_id')
        .eq('gateway_reference', reference)
        .single();

      if (payment?.booking_id) {
        await supabase
          .from('bookings')
          .update({ deposit_status: 'paid', status: 'confirmed', confirmed_at: new Date().toISOString() })
          .eq('id', payment.booking_id);
      }
      return true;
    }

    try {
      // Look up the order ID from the payment metadata
      const { data: paymentRecord } = await supabase
        .from('payments')
        .select('id, booking_id, amount, currency, metadata, payout_account_id')
        .eq('gateway_reference', reference)
        .single();

      if (!paymentRecord) return false;

      const metadata = paymentRecord.metadata as Record<string, string> | null;
      const squareOrderId = metadata?.square_order_id;

      if (!squareOrderId) return false;

      // Use seller token for connected merchants, platform token for platform payments
      const verifyToken = byoSecretKey || squareAccessToken;
      const orderResult = verifyToken !== squareAccessToken
        ? await fetch(`${getSquareBaseUrl()}/v2/orders/${encodeURIComponent(squareOrderId)}`, {
            headers: { 'Square-Version': '2024-12-18', Authorization: `Bearer ${verifyToken}` },
          }).then(r => r.json() as Promise<Record<string, unknown>>)
        : await squareGet(`/v2/orders/${encodeURIComponent(squareOrderId)}`);
      const order = orderResult.order as Record<string, unknown> | undefined;

      if (order?.state === 'COMPLETED') {
        // Validate currency (required, nonempty, exact match)
        const orderMoney = order.total_money as { amount?: number; currency?: string } | undefined;
        const orderCurrency = orderMoney?.currency || '';
        const storedCurrency = (paymentRecord.currency as string) || 'USD';
        if (!orderCurrency || orderCurrency.toUpperCase() !== storedCurrency.toUpperCase()) {
          logger.warn('[SQUARE] Verification currency mismatch or missing');
          return false;
        }

        // Validate amount within +/-1 cent
        const orderAmountCents = orderMoney?.amount || 0;
        const expectedCents = Math.round(paymentRecord.amount * 100);
        if (orderAmountCents <= 0 || Math.abs(orderAmountCents - expectedCents) > 1) {
          logger.warn('[SQUARE] Verification amount mismatch');
          return false;
        }

        // Require at least one tender with a nonempty payment_id
        const tenders = (order.tenders || []) as Array<{ type?: string; payment_id?: string }>;
        const validTender = tenders.find(t => !!t.payment_id);
        if (!validTender) {
          logger.warn('[SQUARE] Verification: no tender with payment_id');
          return false;
        }
        const tenderType = validTender.type || '';
        const squarePaymentId = validTender.payment_id;
        const paymentMethod = tenderType === 'CASH_APP' ? 'cash_app_pay'
          : tenderType === 'WALLET' ? 'apple_pay'
          : tenderType === 'CARD' ? 'card'
          : 'square';

        // Require order.location_id
        if (!order.location_id) {
          logger.warn('[SQUARE] Verification: missing order location_id');
          return false;
        }

        if (paymentRecord.payout_account_id) {
          // Connected payment: validate against payout account location
          const { data: payoutAcct, error: locErr } = await supabase
            .from('payout_accounts')
            .select('square_location_id')
            .eq('id', paymentRecord.payout_account_id)
            .maybeSingle();
          if (locErr) {
            logger.error('[SQUARE] Verification: payout account lookup error:', locErr.message);
            return false;
          }
          if (!payoutAcct?.square_location_id) {
            logger.warn('[SQUARE] Verification: no expected location for connected payment');
            return false;
          }
          if (payoutAcct.square_location_id !== order.location_id) {
            logger.warn('[SQUARE] Verification location_id mismatch');
            return false;
          }
        } else {
          // Platform payment: validate against configured platform location (fail closed)
          if (!squareLocationId || squareLocationId !== order.location_id) {
            logger.warn('[SQUARE] Verification: platform location missing or mismatch');
            return false;
          }
        }

        // Conditional update: only transition from pending, verify the row was actually updated
        const { data: updatedRow, error: updateErr } = await supabase
          .from('payments')
          .update({
            status: 'success',
            gateway_status: 'completed',
            payment_method: paymentMethod,
            paid_at: new Date().toISOString(),
            metadata: {
              ...((paymentRecord.metadata as Record<string, unknown>) || {}),
              square_payment_id: squarePaymentId || null,
            },
          })
          .eq('id', paymentRecord.id)
          .in('status', ['pending'])
          .select('id')
          .maybeSingle();

        if (updateErr) {
          logger.error('[SQUARE] Verification update error:', updateErr.message);
          return false;
        }

        // Only confirm booking/order if the update actually matched (returned a row)
        if (updatedRow && paymentRecord.booking_id) {
          await supabase
            .from('bookings')
            .update({ deposit_status: 'paid', status: 'confirmed', confirmed_at: new Date().toISOString() })
            .eq('id', paymentRecord.booking_id);
        }
        return !!updatedRow;
      }
      return false;
    } catch (error) {
      logger.error('Square verify error:', (error as Error).message);
      return false;
    }
  }

  async refundPayment(opts: RefundPaymentOpts): Promise<RefundResult> {
    // Mock mode: only when NEITHER platform NOR connected seller token AND not production
    const hasAnyRefundToken = squareAccessToken || opts.byoSecretKey;
    if ((!hasAnyRefundToken && process.env.NODE_ENV !== 'production') || opts.gatewayReference.startsWith('mock_')) {
      return {
        success: true,
        gatewayRefundReference: `mock_refund_square_${Date.now()}`,
        gatewayResponse: { mock: true },
      };
    }
    if (!hasAnyRefundToken && process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: no Square access token');
    }

    try {
      // Only refund using an explicitly persisted Square payment ID.
      // gateway_reference holds the payment_link_id at init time — NEVER use it as payment_id.
      // metadata.square_payment_id is set by the webhook after reconciliation.
      let paymentId = opts.metadata?.square_payment_id as string | undefined;

      if (!paymentId) {
        // Recover payment ID from Square order using the seller credential.
        // Validates ownership, currency, and amount before extracting the payment ID.
        const orderId = opts.metadata?.square_order_id as string | undefined;
        if (orderId) {
          const useToken = opts.byoSecretKey || squareAccessToken;
          if (!useToken) {
            return { success: false, errorMessage: 'No Square access token for order lookup' };
          }
          const orderResult = await (useToken !== squareAccessToken
            ? fetch(`${getSquareBaseUrl()}/v2/orders/${encodeURIComponent(orderId)}`, {
                headers: { 'Square-Version': '2024-12-18', Authorization: `Bearer ${useToken}` },
              }).then(r => r.json() as Promise<Record<string, unknown>>)
            : squareGet(`/v2/orders/${encodeURIComponent(orderId)}`));

          const order = orderResult.order as Record<string, unknown> | undefined;
          if (order) {
            // Validate currency
            const orderMoney = order.total_money as Record<string, unknown> | undefined;
            const orderCurrency = (orderMoney?.currency as string) || '';
            if (!orderCurrency || orderCurrency.toUpperCase() !== (opts.currency || 'USD').toUpperCase()) {
              return { success: false, errorMessage: 'Order currency mismatch — cannot safely refund' };
            }

            // Validate amount
            const orderAmountCents = (orderMoney?.amount as number) || 0;
            const expectedCents = Math.round((opts.amount ?? 0) * 100);
            if (expectedCents > 0 && orderAmountCents > 0 && orderAmountCents < expectedCents) {
              return { success: false, errorMessage: 'Order amount less than refund — cannot safely refund' };
            }

            const tenders = (order.tenders || []) as Array<{ payment_id?: string }>;
            paymentId = tenders[0]?.payment_id;

            if (paymentId) {
              logger.info('[SQUARE] Recovered payment ID from order lookup (validated)');
            }
          }
        }
      }

      if (!paymentId) {
        return { success: false, errorMessage: 'Square payment ID not found — payment may not be completed yet' };
      }

      // Use the stable provider idempotency key from the refund claim.
      // This key was stored before calling Square and must be reused on retry.
      if (!opts.providerIdempotencyKey) {
        return { success: false, errorMessage: 'Missing provider idempotency key — refund not claimed' };
      }

      const refundBody: Record<string, unknown> = {
        idempotency_key: opts.providerIdempotencyKey,
        payment_id: paymentId,
        reason: opts.reason || 'Refund requested',
      };

      // Always send exact amount in minor units (Square requires amount_money for
      // connected-account refunds to calculate proportional app_fee reversal).
      const refundAmount = opts.amount ?? 0;
      if (refundAmount <= 0) {
        return { success: false, errorMessage: 'Refund amount must be positive' };
      }
      refundBody.amount_money = {
        amount: Math.round(refundAmount * 100),
        currency: (opts.currency || 'USD').toUpperCase(),
      };

      // Reverse proportional app fee if specified
      if (opts.appFeeRefundAmount && opts.appFeeRefundAmount > 0) {
        refundBody.app_fee_money = {
          amount: Math.round(opts.appFeeRefundAmount * 100),
          currency: (opts.currency || 'USD').toUpperCase(),
        };
      }

      // Use the connected merchant's token if available
      const useToken = opts.byoSecretKey || squareAccessToken;
      const result = useToken !== squareAccessToken
        ? await fetch(`${getSquareBaseUrl()}/v2/refunds`, {
            method: 'POST',
            headers: {
              'Square-Version': '2024-12-18',
              Authorization: `Bearer ${useToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(refundBody),
          }).then(r => r.json() as Promise<Record<string, unknown>>)
        : await squareRequest('/v2/refunds', refundBody);

      const refund = result.refund as Record<string, unknown> | undefined;
      if (refund?.id) {
        return {
          success: true,
          gatewayRefundReference: refund.id as string,
          gatewayResponse: result,
        };
      }

      // Check for errors in the response
      const errors = result.errors as Array<{ detail?: string }> | undefined;
      const errorMsg = errors?.[0]?.detail || 'Square refund failed';
      logger.error('[SQUARE] Refund failed:', JSON.stringify(result).slice(0, 500));
      return { success: false, errorMessage: errorMsg, gatewayResponse: result };
    } catch (error) {
      logger.error('[SQUARE] Refund error:', (error as Error).message);
      return { success: false, errorMessage: (error as Error).message };
    }
  }
}
