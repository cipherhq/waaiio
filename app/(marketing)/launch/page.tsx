import type { Metadata } from 'next';
import LaunchClient from './LaunchClient';

export const metadata: Metadata = {
  title: 'Waaiio Launches October 2 — Get Notified on WhatsApp',
  description:
    'Waaiio lets businesses accept bookings, payments, orders, donations, and tickets on WhatsApp. Get notified when we launch.',
  openGraph: {
    title: 'Waaiio Launches October 2',
    description: 'Get notified on WhatsApp when Waaiio launches.',
  },
};

export default function LaunchPage() {
  return <LaunchClient />;
}
