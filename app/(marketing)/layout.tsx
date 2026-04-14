import type { Metadata } from 'next';
import Navbar from '@/components/marketing/Navbar';
import Footer from '@/components/marketing/Footer';

export const metadata: Metadata = {
  title: 'Waaiio — WhatsApp Automation for Every Business',
  description:
    'AI-powered WhatsApp automation for 40+ industries with 20+ capabilities — bookings, payments, orders, ticketing, loyalty, broadcasts, and more. Paystack, Square, Stripe & Flutterwave gateways. Available in Nigeria, US, UK, Canada & Ghana.',
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
