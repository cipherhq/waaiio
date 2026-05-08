import { ReturnToWhatsApp } from '@/components/ReturnToWhatsApp';
import { createServiceClient } from '@/lib/supabase/service';

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

  // Try to look up business phone from payment reference
  if (params.ref) {
    try {
      const supabase = createServiceClient();
      const { data: payment } = await supabase
        .from('payments')
        .select('business_id, businesses(phone)')
        .like('gateway_reference', `%${params.ref}`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (payment) {
        const biz = payment.businesses as unknown as { phone: string } | null;
        businessPhone = biz?.phone || undefined;
      }
    } catch {
      // Non-critical — fall back to platform number
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
      <div className="mx-auto max-w-sm">
        <div className="text-5xl mb-4">✅</div>
        <h1 className="text-2xl font-bold text-gray-900">Payment Received!</h1>
        <p className="mt-3 text-sm text-gray-600 leading-relaxed">
          Thank you! Go back to WhatsApp and tap <strong>&quot;I&apos;ve Paid&quot;</strong> to confirm.
        </p>
        <ReturnToWhatsApp phone={businessPhone} />
        <p className="mt-4 text-xs text-gray-400">Powered by Waaiio</p>
      </div>
    </div>
  );
}
