import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Pricing — Simple, Transparent Plans',
  description:
    'Start free with a 7-day trial. No credit card required. Pay only for what you use with Waaiio WhatsApp automation — plans for Nigeria, US, UK, Canada, and Ghana.',
  alternates: { canonical: '/pricing' },
};

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
