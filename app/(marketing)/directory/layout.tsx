import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Business Directory',
  description: 'Discover businesses powered by Waaiio. Book appointments, place orders, and make payments directly on WhatsApp.',
  alternates: { canonical: '/directory' },
};

export default function DirectoryLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
