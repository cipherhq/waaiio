import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { PostHogProvider } from '@/components/PostHogProvider';
import CookieConsent from '@/components/marketing/CookieConsent';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: {
    default: 'Waaiio — AI-Powered WhatsApp Automation for Every Business',
    template: '%s | Waaiio',
  },
  description:
    'Automate bookings, payments, orders, donations, and tickets on WhatsApp for 40+ industries — churches, salons, clinics, restaurants, schools, shops, and more.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com'),
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    siteName: 'Waaiio',
    type: 'website',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Waaiio — AI-Powered WhatsApp Automation for Every Business',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/og-image.png'],
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
        <PostHogProvider>
          {children}
        </PostHogProvider>
        <CookieConsent />
      </body>
    </html>
  );
}
