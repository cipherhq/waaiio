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
    </>
  );
}
