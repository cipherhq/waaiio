import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { PaymentGateway, InitPaymentOpts, InitPaymentResult } from './types';

const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY || '';

export class FlutterwaveGateway implements PaymentGateway {
  name = 'flutterwave' as const;

  async initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null> {
    const txRef = `flw_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const email = opts.userEmail || `${opts.phone.replace('+', '')}@whatsapp.waaiio.com`;

    try {
      // Mock mode when no secret key
      if (!flutterwaveSecretKey) {
        const mockRef = `mock_flw_${randomUUID()}`;
        await opts.supabase.from('payments').insert({
          booking_id: opts.bookingId || null,
          user_id: opts.userId,
          amount: opts.amount,
          currency: opts.currency,
          gateway: 'flutterwave',
          gateway_reference: mockRef,
          status: 'pending',
          metadata: { reference_code: opts.referenceCode, channel: 'whatsapp', order_id: opts.orderId || null },
        });
        return { url: `https://waaiio.com/pay?ref=${mockRef}`, reference: mockRef };
      }

      const callbackUrl = opts.callbackUrl || process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

      const response = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${flutterwaveSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tx_ref: txRef,
          amount: opts.amount,
          currency: opts.currency,
          redirect_url: `${callbackUrl}/api/webhooks/flutterwave/redirect?ref=${txRef}`,
          // Split to business subaccount
          ...(opts.subaccountCode && {
            subaccounts: [{
              id: opts.subaccountCode,
              transaction_charge_type: 'flat',
              transaction_charge: opts.platformFeeAmount || 0,
            }],
          }),
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
          },
          customizations: {
            title: opts.businessName,
            description: `Payment - ${opts.referenceCode}`,
          },
        }),
      });

      const data = await response.json();

      if (data.status !== 'success' || !data.data?.link) {
        console.error('Flutterwave init failed:', data);
        return null;
      }

      const { data: payment } = await opts.supabase.from('payments').insert({
        booking_id: opts.bookingId || null,
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
        },
      }).select().single();

      if (payment && opts.bookingId) {
        await opts.supabase.from('bookings').update({ payment_id: payment.id }).eq('id', opts.bookingId);
      }

      return { url: data.data.link, reference: txRef };
    } catch (error) {
      console.error('Flutterwave init error:', (error as Error).message);
      return null;
    }
  }

  async verifyPayment(supabase: SupabaseClient, reference: string): Promise<boolean> {
    // Mock mode
    if (!flutterwaveSecretKey || reference.startsWith('mock_')) {
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
        { headers: { Authorization: `Bearer ${flutterwaveSecretKey}` } },
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
      console.error('Flutterwave verify error:', (error as Error).message);
      return false;
    }
  }
}
