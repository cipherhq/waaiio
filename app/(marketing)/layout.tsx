import type { Metadata } from 'next';
import Navbar from '@/components/marketing/Navbar';
import Footer from '@/components/marketing/Footer';

export const metadata: Metadata = {
  title: 'SmrtRply — WhatsApp Automation for Every Business',
  description:
    'Automate bookings, payments, orders, and tickets on WhatsApp. Available in Nigeria, US, UK, Canada & Ghana — restaurants, barbers, churches, shops, events, and more.',
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
