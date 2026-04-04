import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: {
    default: 'SmrtRply — WhatsApp Booking Assistant for Restaurants',
    template: '%s | SmrtRply',
  },
  description:
    'Give your restaurant its own AI-powered WhatsApp booking assistant. Accept reservations 24/7, reduce no-shows, and delight guests.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://smrtrply.com'),
  openGraph: {
    siteName: 'SmrtRply',
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
      </body>
    </html>
  );
}
