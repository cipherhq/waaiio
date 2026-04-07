import type { Metadata } from 'next';
import Navbar from '@/components/marketing/Navbar';
import Footer from '@/components/marketing/Footer';

export const metadata: Metadata = {
  title: 'Waaiio — WhatsApp Automation for Every Business',
  description:
    'AI-powered WhatsApp automation for 35+ industries — churches, mosques, salons, clinics, restaurants, schools, NGOs, shops, events, and more. Bookings, payments, orders, donations, and ticketing. Available in Nigeria, US, UK, Canada & Ghana.',
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
