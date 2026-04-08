import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import CookieConsent from '@/components/marketing/CookieConsent';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: {
    default: 'Waaiio — AI-Powered WhatsApp Automation for Every Business',
    template: '%s | Waaiio',
  },
  description:
    'Automate bookings, payments, orders, donations, and tickets on WhatsApp for 35+ industries — churches, salons, clinics, restaurants, schools, shops, and more.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com'),
  openGraph: {
    siteName: 'Waaiio',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased`}>
        {children}
        <CookieConsent />
      </body>
    </html>
  );
}
