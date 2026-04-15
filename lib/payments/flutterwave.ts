import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { PaymentGateway, InitPaymentOpts, InitPaymentResult, RefundPaymentOpts, RefundResult } from './types';
import { logger } from '@/lib/logger';

const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY || '';

export class FlutterwaveGateway implements PaymentGateway {
  name = 'flutterwave' as const;

  async initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null> {
    const txRef = `flw_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const email = opts.userEmail || `${opts.phone.replace('+', '')}@whatsapp.waaiio.com`;

    // BYO: use business's own API key; platform flow: use platform key
    const secretKey = opts.isByo && opts.byoSecretKey ? opts.byoSecretKey : flutterwaveSecretKey;

    try {
      // Mock mode when no secret key
      if (!secretKey) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('Payment gateway not configured: missing Flutterwave secret key');
        }
        const mockRef = `mock_flw_${randomUUID()}`;
        await opts.supabase.from('payments').insert({
          booking_id: opts.bookingId || null,
          invoice_id: opts.invoiceId || null,
          user_id: opts.userId,
          amount: opts.amount,
          currency: opts.currency,
          gateway: 'flutterwave',
          gateway_reference: mockRef,
          status: 'pending',
          metadata: { reference_code: opts.referenceCode, channel: 'whatsapp', order_id: opts.orderId || null, byo: !!opts.isByo },
        });
        return { url: `https://waaiio.com/pay?ref=${mockRef}`, reference: mockRef };
      }

      const callbackUrl = opts.callbackUrl || process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

      // Build split params
      let splitParams: Record<string, unknown> = {};
      if (opts.isByo && opts.byoPlatformSubaccount && opts.platformFeeAmount != null) {
        // BYO reversed split: platform subaccount on business's account
        // transaction_charge = amount business keeps (their share)
        const businessKeeps = opts.amount - opts.platformFeeAmount;
        splitParams = {
          subaccounts: [{
            id: opts.byoPlatformSubaccount,
            transaction_charge_type: 'flat',
            transaction_charge: businessKeeps,
          }],
        };
      } else if (opts.subaccountCode) {
        // Normal platform split
        splitParams = {
          subaccounts: [{
            id: opts.subaccountCode,
            transaction_charge_type: 'flat',
            transaction_charge: opts.platformFeeAmount || 0,
          }],
        };
      }

      const response = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tx_ref: txRef,
          amount: opts.amount,
          currency: opts.currency,
          redirect_url: `${callbackUrl}/api/webhooks/flutterwave/redirect?ref=${txRef}`,
          ...splitParams,
          customer: {
            email,
            phonenumber: opts.phone,
            name: opts.businessName,
          },
          meta: {
            booking_id: opts.bookingId || null,
            order_id: opts.orderId || null,
            user_id: opts.userId,
            reference_code: opts.referenceCode,
            channel: 'whatsapp',
            byo: !!opts.isByo,
            byo_business_id: opts.byoBusinessId || null,
          },
          customizations: {
            title: opts.businessName,
            description: `Payment - ${opts.referenceCode}`,
          },
        }),
      });

      const data = await response.json();

      if (data.status !== 'success' || !data.data?.link) {
        logger.error('Flutterwave init failed:', data);
        return null;
      }

      const { data: payment } = await opts.supabase.from('payments').insert({
        booking_id: opts.bookingId || null,
        invoice_id: opts.invoiceId || null,
        user_id: opts.userId,
        amount: opts.amount,
        currency: opts.currency,
        gateway: 'flutterwave',
        gateway_reference: txRef,
        status: 'pending',
        metadata: {
          flw_link: data.data.link,
          reference_code: opts.referenceCode,
          channel: 'whatsapp',
          order_id: opts.orderId || null,
          ...(opts.isByo && { byo: true, byo_business_id: opts.byoBusinessId }),
        },
      }).select().single();

      if (payment && opts.bookingId) {
        await opts.supabase.from('bookings').update({ payment_id: payment.id }).eq('id', opts.bookingId);
      }
      if (payment && opts.invoiceId) {
        await opts.supabase.from('invoices').update({ payment_id: payment.id }).eq('id', opts.invoiceId);
      }

      return { url: data.data.link, reference: txRef };
    } catch (error) {
      logger.error('Flutterwave init error:', (error as Error).message);
      return null;
    }
  }

  async verifyPayment(supabase: SupabaseClient, reference: string, byoSecretKey?: string): Promise<boolean> {
    const secretKey = byoSecretKey || flutterwaveSecretKey;
    // Mock mode
    if (!secretKey || reference.startsWith('mock_')) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Payment gateway not configured: missing Flutterwave secret key');
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
      // Find the transaction ID by tx_ref
      const searchRes = await fetch(
        `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${secretKey}` } },
      );
      const searchData = await searchRes.json();

      if (searchData.status === 'success' && searchData.data?.status === 'successful') {
        const { data: payment } = await supabase
          .from('payments')
          .select('id, booking_id, amount')
          .eq('gateway_reference', reference)
          .single();

        if (payment) {
          const webhookAmount = searchData.data.amount as number;
          if (webhookAmount !== payment.amount) return false;

          await supabase
            .from('payments')
            .update({
              status: 'success',
              gateway_status: 'successful',
              payment_method: (searchData.data.payment_type as string) || 'card',
              card_last_four: searchData.data.card?.last_4digits || null,
              card_brand: searchData.data.card?.type || null,
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
      logger.error('Flutterwave verify error:', (error as Error).message);
      return false;
    }
  }

  async refundPayment(opts: RefundPaymentOpts): Promise<RefundResult> {
    const secretKey = opts.byoSecretKey || flutterwaveSecretKey;

    // Mock mode
    if (!secretKey || opts.gatewayReference.startsWith('mock_')) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Payment gateway not configured: missing Flutterwave secret key');
      }
      return {
        success: true,
        gatewayRefundReference: `mock_refund_flw_${Date.now()}`,
        gatewayResponse: { mock: true },
      };
    }

    try {
      // First resolve tx_ref to transaction id via verify-by-reference
      const verifyRes = await fetch(
        `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(opts.gatewayReference)}`,
        { headers: { Authorization: `Bearer ${secretKey}` } },
      );
      const verifyData = await verifyRes.json();

      if (verifyData.status !== 'success' || !verifyData.data?.id) {
        return {
          success: false,
          errorMessage: 'Could not resolve Flutterwave transaction reference',
          gatewayResponse: verifyData,
        };
      }

      const transactionId = verifyData.data.id as number;

      const body: Record<string, unknown> = {};
      if (opts.amount != null) {
        body.amount = opts.amount;
      }

      const refundRes = await fetch(
        `https://api.flutterwave.com/v3/transactions/${transactionId}/refund`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );

      const refundData = await refundRes.json();

      if (refundData.status === 'success') {
        return {
          success: true,
          gatewayRefundReference: refundData.data?.id?.toString(),
          gatewayResponse: refundData.data,
        };
      }

      return {
        success: false,
        errorMessage: refundData.message || 'Flutterwave refund failed',
        gatewayResponse: refundData,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: `Flutterwave refund error: ${(error as Error).message}`,
      };
    }
  }
}
