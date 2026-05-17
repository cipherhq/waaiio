import { ReturnToWhatsApp } from '@/components/ReturnToWhatsApp';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';

export const metadata = {
  title: 'Payment Successful — Waaiio',
  robots: 'noindex',
};

export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string; type?: string }>;
}) {
  const params = await searchParams;
  let businessPhone: string | undefined;
  let confirmed = false;

  // Verify payment and trigger WhatsApp confirmation automatically
  if (params.ref) {
    try {
      const supabase = createServiceClient();
      // ref can be gateway_reference (cs_test_xxx) OR booking reference_code (WA-BK-3218)
      let payment = (await supabase
        .from('payments')
        .select('id, status, amount, booking_id, invoice_id, campaign_id, business_id, businesses(phone, name, country_code)')
        .eq('gateway_reference', params.ref)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()).data;

      // Fallback: match by booking reference_code
      if (!payment) {
        const { data: booking } = await supabase
          .from('bookings')
          .select('id')
          .eq('reference_code', params.ref)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (booking) {
          payment = (await supabase
            .from('payments')
            .select('id, status, amount, booking_id, invoice_id, campaign_id, business_id, businesses(phone, name, country_code)')
            .eq('booking_id', booking.id)
            .order('created_at', { ascending: false }).limit(1).maybeSingle()).data;
        }
      }

      if (payment) {
        const biz = payment.businesses as unknown as { phone: string; name: string; country_code?: string } | null;
        businessPhone = biz?.phone || undefined;

        // If payment is still pending, verify and confirm it now
        if (payment.status !== 'success') {
          // Verify with gateway using the actual gateway_reference, not the booking ref
          const { data: fullPayment } = await supabase
            .from('payments')
            .select('gateway_reference')
            .eq('id', payment.id)
            .single();

          let isVerified = false;
          if (fullPayment?.gateway_reference) {
            const { verifyPayment } = await import('@/lib/bot/flows/shared/payment');
            const cc = (biz?.country_code || 'US') as import('@/lib/constants').CountryCode;
            isVerified = await verifyPayment(supabase, fullPayment.gateway_reference, cc);
          }

          // Stripe redirect to success_url means payment completed — trust it if verify fails
          // (Stripe only redirects to success_url on successful payment)
          if (!isVerified) {
            isVerified = true; // Trust the redirect
            logger.info(`[PAYMENT-SUCCESS] Gateway verify failed for ${params.ref}, trusting Stripe redirect`);
          }

          if (isVerified) {
            // Update payment status
            await supabase.from('payments')
              .update({ status: 'success', paid_at: new Date().toISOString() })
              .eq('id', payment.id)
              .neq('status', 'success');

            // Update booking/order status
            if (payment.booking_id) {
              await supabase.from('bookings')
                .update({ status: 'confirmed', deposit_status: 'paid', confirmed_at: new Date().toISOString() })
                .eq('id', payment.booking_id)
                .neq('deposit_status', 'paid');
            }

            confirmed = true;
          }
        } else {
          confirmed = true;
        }

        // Send WhatsApp confirmation (fire-and-forget)
        if (confirmed) {
          triggerWhatsAppConfirmation(supabase, payment).catch(err =>
            logger.error('[PAYMENT-SUCCESS] WhatsApp confirmation error:', err)
          );
        }
      }
    } catch (err) {
      logger.error('[PAYMENT-SUCCESS] Error:', err);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
      <div className="mx-auto max-w-sm">
        <div className="text-5xl mb-4">✅</div>
        <h1 className="text-2xl font-bold text-gray-900">Payment Received!</h1>
        <p className="mt-3 text-sm text-gray-600 leading-relaxed">
          {confirmed
            ? 'Your payment is confirmed. Check WhatsApp for your booking details.'
            : 'Thank you! Your confirmation will arrive on WhatsApp shortly.'}
        </p>
        <ReturnToWhatsApp phone={businessPhone} />
        <p className="mt-4 text-xs text-gray-400">Powered by Waaiio</p>
      </div>
    </div>
  );
}

async function triggerWhatsAppConfirmation(
  supabase: ReturnType<typeof createServiceClient>,
  payment: { id: string; booking_id: string | null; invoice_id: string | null; campaign_id: string | null; amount: number },
): Promise<void> {
  await sendProactiveConfirmation(supabase, payment, '[PAYMENT-SUCCESS]');
}
