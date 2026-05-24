import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Help Center — Waaiio',
  description: 'Find answers to common questions about Waaiio — setup, bookings, payments, WhatsApp bot, payouts, and more.',
  openGraph: {
    title: 'Help Center — Waaiio',
    description: 'Find answers to common questions about Waaiio — setup, bookings, payments, WhatsApp bot, payouts, and more.',
  },
};

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return children;
}
