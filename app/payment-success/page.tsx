import { ReturnToWhatsApp } from '@/components/ReturnToWhatsApp';

export const metadata = {
  title: 'Payment Successful — Waaiio',
  robots: 'noindex',
};

export default function PaymentSuccessPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
      <div className="mx-auto max-w-sm">
        <div className="text-5xl mb-4">✅</div>
        <h1 className="text-2xl font-bold text-gray-900">Payment Received!</h1>
        <p className="mt-3 text-sm text-gray-600 leading-relaxed">
          Thank you! Go back to WhatsApp and tap <strong>&quot;I&apos;ve Paid&quot;</strong> to confirm.
        </p>
        <ReturnToWhatsApp />
        <p className="mt-4 text-xs text-gray-400">Powered by Waaiio</p>
      </div>
    </div>
  );
}
