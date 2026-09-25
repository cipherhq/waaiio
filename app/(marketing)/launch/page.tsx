import type { Metadata } from 'next';
import LaunchClient from './LaunchClient';

export const metadata: Metadata = {
  title: 'Waaiio — Get Notified on WhatsApp When We Launch',
  description:
    'Waaiio lets businesses accept bookings, payments, orders, donations, and tickets on WhatsApp. Get notified when we launch.',
  openGraph: {
    title: 'Waaiio — Coming Soon',
    description: 'Get notified on WhatsApp when Waaiio launches.',
  },
};

export default function LaunchPage() {
  return <LaunchClient />;
}
