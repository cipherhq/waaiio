import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { PostHogProvider } from '@/components/PostHogProvider';
import CookieConsent from '@/components/marketing/CookieConsent';
import { BRAND_NAME, WORDMARK_PATH, WORDMARK_WIDTH, WORDMARK_HEIGHT, WORDMARK_ALT, FAVICON_PATH, ICON_PATH } from '@/lib/brand';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: {
    default: 'Waaiio — WhatsApp Automation for Every Business',
    template: '%s | Waaiio',
  },
  description:
    'Automate bookings, payments, orders, donations, and tickets on WhatsApp for 89+ business types across 16 industries — churches, salons, clinics, restaurants, schools, shops, and more.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'),
  manifest: '/manifest.webmanifest',
  icons: {
    icon: FAVICON_PATH,
    apple: ICON_PATH,
  },
  openGraph: {
    siteName: BRAND_NAME,
    type: 'website',
    images: [{ url: WORDMARK_PATH, width: WORDMARK_WIDTH, height: WORDMARK_HEIGHT, alt: WORDMARK_ALT }],
  },
  twitter: {
    card: 'summary_large_image',
    images: [WORDMARK_PATH],
  },
  alternates: {
    canonical: process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com',
  },
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${inter.className} antialiased`}>
        <PostHogProvider>
          {children}
        </PostHogProvider>
        <CookieConsent />
      </body>
    </html>
  );
}
