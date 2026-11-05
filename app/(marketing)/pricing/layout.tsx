import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Pricing — Simple, Transparent Plans',
  description:
    'Start free with a trial period. No credit card required. Pay only for what you use with Waaiio WhatsApp automation — plans for Nigeria, the US, the UK and Canada.',
  alternates: { canonical: '/pricing' },
};

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
