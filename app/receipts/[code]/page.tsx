import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { ReceiptClient } from './ReceiptClient';

export const revalidate = 0; // No caching — always fresh

interface PageProps {
  params: Promise<{ code: string }>;
}

async function getReceiptData(code: string) {
  const supabase = await createClient();

  // Fetch booking by reference_code with joins
  const { data: booking } = await supabase
    .from('bookings')
    .select(
      `id, reference_code, date, time, status, total_amount, deposit_amount, deposit_status,
       guest_name, guest_phone, created_at,
       services(name),
       businesses!inner(name, logo_url, country_code, is_active)`
    )
    .eq('reference_code', code)
    .eq('businesses.is_active', true)
    .single();

  if (!booking) return null;

  const business = booking.businesses as unknown as {
    name: string;
    logo_url: string | null;
    country_code: string | null;
    is_active: boolean;
  } | null;

  const service = booking.services as unknown as { name: string } | null;

  // Try to find payment record for this booking to get the gateway/method
  let paymentGateway: string | null = null;
  const { data: payment } = await supabase
    .from('payments')
    .select('gateway, status')
    .eq('booking_id', booking.id)
    .eq('status', 'success')
    .limit(1)
    .maybeSingle();

  if (payment) {
    paymentGateway = payment.gateway;
  }

  const countryCode = (business?.country_code || 'NG') as CountryCode;
  const isPaid =
    booking.deposit_status === 'paid' ||
    booking.status === 'confirmed' ||
    booking.status === 'completed';

  return {
    referenceCode: booking.reference_code || code,
    businessName: business?.name || 'Business',
    businessLogo: business?.logo_url || null,
    serviceName: service?.name || 'Service',
    guestName: booking.guest_name || 'Guest',
    date: booking.date || booking.created_at,
    time: booking.time || null,
    amount: booking.total_amount || 0,
    formattedAmount: formatCurrency(booking.total_amount || 0, countryCode),
    paymentGateway: paymentGateway
      ? paymentGateway.charAt(0).toUpperCase() + paymentGateway.slice(1)
      : null,
    isPaid,
    status: isPaid ? 'Paid' : 'Pending',
    countryCode,
  };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { code } = await params;
  const data = await getReceiptData(code);

  if (!data) {
    return { title: 'Receipt Not Found | Waaiio' };
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  return {
    title: `Receipt from ${data.businessName} | Waaiio`,
    description: `Receipt ${data.referenceCode} — ${data.formattedAmount} for ${data.serviceName}`,
    openGraph: {
      title: `Receipt from ${data.businessName}`,
      description: `${data.formattedAmount} — ${data.serviceName}`,
      url: `${baseUrl}/receipts/${code}`,
      images: [{ url: `${baseUrl}/opengraph-image` }],
    },
    robots: { index: false, follow: false },
  };
}

export default async function ReceiptPage({ params }: PageProps) {
  const { code } = await params;
  const data = await getReceiptData(code);

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
            <svg className="h-8 w-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Receipt Not Found</h1>
          <p className="mt-2 text-gray-500">
            We could not find a receipt with this reference code. Please check the link and try again.
          </p>
        </div>
      </div>
    );
  }

  return <ReceiptClient data={data} />;
}
