import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { PaymentGateway, InitPaymentOpts, InitPaymentResult } from './types';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';

export class PaystackGateway implements PaymentGateway {
  name = 'paystack' as const;

  async initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null> {
    const idempotencyKey = randomUUID();
    const amountInKobo = Math.round(opts.amount * 100);
    const email = opts.userEmail || `${opts.phone.replace('+', '')}@whatsapp.smrtrply.com`;

    try {
      if (!paystackSecretKey) {
        const mockRef = `mock_ps_${idempotencyKey}`;
        await opts.supabase.from('payments').insert({
          booking_id: opts.bookingId || null,
          user_id: opts.userId,
          amount: opts.amount,
          currency: opts.currency,
          gateway: 'paystack',
          gateway_reference: mockRef,
          status: 'pending',
          metadata: { reference_code: opts.referenceCode, channel: 'whatsapp', order_id: opts.orderId || null },
        });
        return { url: `https://smrtrply.com/pay?ref=${mockRef}`, reference: mockRef };
      }

      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          amount: amountInKobo,
          currency: opts.currency,
          metadata: {
            booking_id: opts.bookingId || null,
            order_id: opts.orderId || null,
            user_id: opts.userId,
            reference_code: opts.referenceCode,
            channel: 'whatsapp',
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
        },
      }).select().single();

      if (payment && opts.bookingId) {
        await opts.supabase.from('bookings').update({ payment_id: payment.id }).eq('id', opts.bookingId);
      }

      return { url: data.data.authorization_url, reference: data.data.reference };
    } catch (error) {
      console.error('Paystack init error:', (error as Error).message);
      return null;
    }
  }

  async verifyPayment(supabase: SupabaseClient, reference: string): Promise<boolean> {
    if (!paystackSecretKey || reference.startsWith('mock_')) {
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
        { headers: { Authorization: `Bearer ${paystackSecretKey}` } },
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
      console.error('Paystack verify error:', (error as Error).message);
      return false;
    }
  }
}
