import type { Metadata } from 'next';
import Navbar from '@/components/marketing/Navbar';
import Footer from '@/components/marketing/Footer';

export const metadata: Metadata = {
  title: 'Waaiio — Your WhatsApp. Now 10x Smarter.',
  description:
    'Automate bookings, payments, orders, and customer engagement on WhatsApp — for any business, any industry, any country. AI-powered automation for 40+ industries with 20+ capabilities.',
};

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Navbar />
      <main>{children}</main>
      <Footer />
      {/* Sticky mobile CTA */}
      <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur-sm sm:hidden">
        <a
          href="/get-started"
          className="block w-full rounded-xl bg-brand py-3 text-center text-sm font-bold text-white shadow-lg transition hover:bg-brand-600"
        >
          Get Started Free
        </a>
      </div>
    </>
  );
}
