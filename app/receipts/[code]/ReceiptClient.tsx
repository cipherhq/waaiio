'use client';

import { isWhiteLabel } from '@/lib/whitelabel';

interface ReceiptData {
  referenceCode: string;
  businessName: string;
  businessLogo: string | null;
  serviceName: string;
  guestName: string;
  date: string;
  time: string | null;
  amount: number;
  formattedAmount: string;
  paymentGateway: string | null;
  isPaid: boolean;
  status: string;
  countryCode: string;
  subscriptionTier?: string;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso.includes('T') ? iso : iso + 'T00:00');
    return d.toLocaleDateString('en-US', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatTime(time: string | null): string {
  if (!time) return '';
  try {
    const [h, m] = time.split(':');
    const hour = parseInt(h, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour % 12 || 12;
    return `${h12}:${m} ${ampm}`;
  } catch {
    return time;
  }
}

export function ReceiptClient({ data }: { data: ReceiptData }) {
  return (
    <div className="min-h-screen bg-gray-50 print:bg-white">
      {/* Header */}
      <header className="border-b bg-white px-4 py-4 shadow-sm print:hidden">
        <div className="mx-auto max-w-lg">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Receipt</p>
          <p className="text-sm font-bold text-gray-900">{data.businessName}</p>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-6">
        {/* Receipt card */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm print:shadow-none print:border-gray-300">
          {/* Business header */}
          <div className="border-b border-gray-100 px-6 py-5 text-center">
            {data.businessLogo && (
              <div className="mx-auto mb-3 h-16 w-16 overflow-hidden rounded-full border border-gray-200">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={data.businessLogo}
                  alt={data.businessName}
                  className="h-full w-full object-cover"
                />
              </div>
            )}
            <h2 className="text-lg font-bold text-gray-900">{data.businessName}</h2>
            <p className="mt-1 text-sm text-gray-500">Receipt</p>
          </div>

          {/* Status badge */}
          <div className="border-b border-gray-100 px-6 py-3 text-center">
            {data.isPaid ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1 text-sm font-medium text-green-700 ring-1 ring-green-200">
                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Paid
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700 ring-1 ring-amber-200">
                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                </svg>
                Pending
              </span>
            )}
          </div>

          {/* Receipt details */}
          <div className="px-6 py-4 space-y-4">
            {/* Reference code */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Reference</span>
              <span className="text-sm font-mono font-medium text-gray-900">{data.referenceCode}</span>
            </div>

            {/* Divider */}
            <hr className="border-gray-100" />

            {/* Date */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Date</span>
              <span className="text-sm text-gray-900">{formatDate(data.date)}</span>
            </div>

            {/* Time */}
            {data.time && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">Time</span>
                <span className="text-sm text-gray-900">{formatTime(data.time)}</span>
              </div>
            )}

            {/* Service */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Service</span>
              <span className="text-sm text-gray-900">{data.serviceName}</span>
            </div>

            {/* Guest */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Guest</span>
              <span className="text-sm text-gray-900">{data.guestName}</span>
            </div>

            {/* Divider */}
            <hr className="border-gray-100" />

            {/* Amount */}
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">Amount Paid</span>
              <span className="text-lg font-bold text-gray-900">{data.formattedAmount}</span>
            </div>

            {/* Payment method */}
            {data.paymentGateway && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">Payment Method</span>
                <span className="text-sm text-gray-900">{data.paymentGateway}</span>
              </div>
            )}
          </div>
        </div>

        {/* Print button */}
        <div className="mt-6 print:hidden">
          <button
            onClick={() => window.print()}
            className="w-full rounded-xl border border-gray-300 bg-white px-6 py-3 text-center text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50"
          >
            Print Receipt
          </button>
        </div>

        {/* Footer */}
        {!isWhiteLabel(data.subscriptionTier) && (
          <p className="mt-6 text-center text-xs text-gray-400 print:mt-8">
            Powered by Waaiio
          </p>
        )}
      </main>

    </div>
  );
}
