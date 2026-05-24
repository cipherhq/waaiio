import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { PaymentGateway, InitPaymentOpts, InitPaymentResult, RefundPaymentOpts, RefundResult } from './types';
import { logger } from '@/lib/logger';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';

export class PaystackGateway implements PaymentGateway {
  name = 'paystack' as const;

  async initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null> {
    const idempotencyKey = randomUUID();
    const amountInKobo = Math.round(opts.amount * 100);
    const email = opts.userEmail || `${opts.phone.replace('+', '')}@${process.env.FALLBACK_EMAIL_DOMAIN || 'whatsapp.waaiio.com'}`;

    // Connect mode: use platform key; BYO: business's own key; else: platform key
    const secretKey = opts.connectAccountId
      ? paystackSecretKey
      : (opts.isByo && opts.byoSecretKey ? opts.byoSecretKey : paystackSecretKey);

    try {
      if (!secretKey) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('Payment gateway not configured: missing Paystack secret key');
        }
        const mockRef = `mock_ps_${idempotencyKey}`;
        await opts.supabase.from('payments').insert({
          booking_id: opts.bookingId || null,
          invoice_id: opts.invoiceId || null,
          campaign_id: opts.campaignId || null,
          user_id: opts.userId,
          amount: opts.amount,
          currency: opts.currency,
          gateway: 'paystack',
          gateway_reference: mockRef,
          status: 'pending',
          metadata: { reference_code: opts.referenceCode, channel: 'whatsapp', order_id: opts.orderId || null, byo: !!opts.isByo },
        });
        return { url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com'}/pay?ref=${mockRef}`, reference: mockRef };
      }

      // Build split params
      let splitParams: Record<string, unknown> = {};
      if (opts.connectAccountId) {
        // Connect mode: split is pre-configured at account level, no params needed
      } else if (opts.isByo && opts.byoPlatformSubaccount && opts.platformFeeAmount != null) {
        // BYO reversed split: platform subaccount on business's account receives platform fee
        // transaction_charge = amount business keeps (total minus platform fee) in kobo
        const businessKeeps = Math.round((opts.amount - opts.platformFeeAmount) * 100);
        splitParams = {
          subaccount: opts.byoPlatformSubaccount,
          transaction_charge: businessKeeps,
        };
      } else if (opts.subaccountCode) {
        // Normal platform split: business subaccount on platform account
        splitParams = {
          subaccount: opts.subaccountCode,
          transaction_charge: opts.platformFeeAmount ? Math.round(opts.platformFeeAmount * 100) : undefined,
        };
      }

      // Build headers — add X-Connect-Account for Connect mode
      const headers: Record<string, string> = {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      };
      if (opts.connectAccountId) {
        headers['X-Connect-Account'] = opts.connectAccountId;
      }

      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          email,
          amount: amountInKobo,
          currency: opts.currency,
          callback_url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com'}/payment-success?ref=${opts.referenceCode}`,
          ...splitParams,
          metadata: {
            booking_id: opts.bookingId || null,
            order_id: opts.orderId || null,
            user_id: opts.userId,
            reference_code: opts.referenceCode,
            channel: 'whatsapp',
            byo: !!opts.isByo,
            connect: !!opts.connectAccountId,
            byo_business_id: opts.byoBusinessId || null,
            custom_fields: [
              { display_name: 'Business', variable_name: 'business', value: opts.businessName },
              { display_name: 'Ref', variable_name: 'ref', value: opts.referenceCode },
            ],
          },
        }),
      });

      const data = await response.json();
      if (!data.status) return null;

      const { data: payment } = await opts.supabase.from('payments').insert({
        booking_id: opts.bookingId || null,
        invoice_id: opts.invoiceId || null,
        campaign_id: opts.campaignId || null,
        business_id: opts.businessId || null,
        user_id: opts.userId,
        amount: opts.amount,
        currency: opts.currency,
        gateway: 'paystack',
        gateway_reference: data.data.reference,
        status: 'pending',
        metadata: {
          access_code: data.data.access_code,
          reference_code: opts.referenceCode,
          channel: 'whatsapp',
          order_id: opts.orderId || null,
          ...(opts.isByo && { byo: true, byo_business_id: opts.byoBusinessId }),
          ...(opts.connectAccountId && { connect: true, connect_account_id: opts.connectAccountId }),
        },
      }).select().single();

      if (payment && opts.bookingId) {
        await opts.supabase.from('bookings').update({ payment_id: payment.id }).eq('id', opts.bookingId);
      }
      if (payment && opts.invoiceId) {
        await opts.supabase.from('invoices').update({ payment_id: payment.id }).eq('id', opts.invoiceId);
      }

      return { url: data.data.authorization_url, reference: data.data.reference };
    } catch (error) {
      logger.error('Paystack init error:', (error as Error).message);
      return null;
    }
  }

  async verifyPayment(supabase: SupabaseClient, reference: string, byoSecretKey?: string): Promise<boolean> {
    const secretKey = byoSecretKey || paystackSecretKey;
    if (!secretKey || reference.startsWith('mock_')) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Payment gateway not configured: missing Paystack secret key');
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
      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${secretKey}` }, signal: AbortSignal.timeout(15000) },
      );
      const data = await response.json();

      if (data?.data?.status === 'success') {
        const { data: payment } = await supabase
          .from('payments')
          .select('id, booking_id, amount')
          .eq('gateway_reference', reference)
          .single();

        if (payment) {
          const webhookAmountKobo = data.data.amount as number;
          const expectedKobo = payment.amount * 100;
          if (webhookAmountKobo !== expectedKobo) return false;

          const authorization = data.data.authorization as Record<string, string> | undefined;
          await supabase
            .from('payments')
            .update({
              status: 'success',
              gateway_status: 'success',
              payment_method: (data.data.channel as string) || 'card',
              card_last_four: authorization?.last4 || null,
              card_brand: authorization?.brand || null,
              paid_at: new Date().toISOString(),
            })
            .eq('id', payment.id);

          if (payment.booking_id) {
            await supabase
              .from('bookings')
              .update({ deposit_status: 'paid', status: 'confirmed', confirmed_at: new Date().toISOString() })
              .eq('id', payment.booking_id);
          }
        }
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Paystack verify error:', (error as Error).message);
      return false;
    }
  }

  async refundPayment(opts: RefundPaymentOpts): Promise<RefundResult> {
    const secretKey = opts.byoSecretKey || paystackSecretKey;

    // Mock mode
    if (!secretKey || opts.gatewayReference.startsWith('mock_')) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Payment gateway not configured: missing Paystack secret key');
      }
      return {
        success: true,
        gatewayRefundReference: `mock_refund_ps_${Date.now()}`,
        gatewayResponse: { mock: true },
      };
    }

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      };
      if (opts.connectAccountId) {
        headers['X-Connect-Account'] = opts.connectAccountId;
      }

      const body: Record<string, unknown> = {
        transaction: opts.gatewayReference,
      };
      if (opts.amount != null) {
        body.amount = Math.round(opts.amount * 100); // convert to kobo
      }

      const response = await fetch('https://api.paystack.co/refund', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json();

      if (data.status === true) {
        return {
          success: true,
          gatewayRefundReference: data.data?.transaction?.reference || data.data?.id?.toString(),
          gatewayResponse: data.data,
        };
      }

      return {
        success: false,
        errorMessage: data.message || 'Paystack refund failed',
        gatewayResponse: data,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: `Paystack refund error: ${(error as Error).message}`,
      };
    }
  }
}
