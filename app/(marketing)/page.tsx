import type { Metadata } from 'next';
import HomeClient from './HomeClient';
import { getCategoryList } from '@/lib/categoryConfig';
import { createServiceClient } from '@/lib/supabase/service';

export const revalidate = 60;

const CATEGORY_COUNT = getCategoryList().filter(c => c.key !== 'other').length;
const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

export const metadata: Metadata = {
  title: 'Waaiio — AI-Powered WhatsApp Automation for Every Business',
  description:
    'Automate bookings, payments, orders, donations, and tickets on WhatsApp for 40+ industries — churches, salons, clinics, restaurants, schools, shops, and more.',
  openGraph: {
    title: 'Waaiio — AI-Powered WhatsApp Automation for Every Business',
    description: 'Automate bookings, payments, orders, donations, and tickets on WhatsApp for 40+ industries.',
    url: baseUrl,
    siteName: 'Waaiio',
    type: 'website',
    images: [{ url: `${baseUrl}/logo.png`, width: 512, height: 512, alt: 'Waaiio' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Waaiio — WhatsApp Automation for Every Business',
    description: 'Automate bookings, payments, orders & more on WhatsApp.',
    images: [`${baseUrl}/logo.png`],
  },
  alternates: {
    canonical: baseUrl,
  },
};

const JSON_LD_ORG = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Waaiio',
  url: baseUrl,
  logo: { '@type': 'ImageObject', url: `${baseUrl}/logo.png`, width: 512, height: 512 },
  description: 'AI-Powered WhatsApp Automation for Every Business',
  foundingDate: '2026',
  award: 'Meta Verified Tech Provider',
  memberOf: {
    '@type': 'Organization',
    name: 'Meta Business Partners',
    url: 'https://www.facebook.com/business/partner-directory',
  },
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'customer support',
    url: `${baseUrl}/contact`,
    email: 'hello@waaiio.com',
    availableLanguage: ['English', 'French', 'Yoruba', 'Igbo', 'Hausa', 'Twi', 'Pidgin'],
  },
  sameAs: [
    'https://www.instagram.com/waaiiobot',
    'https://www.tiktok.com/@waaiiobot',
    'https://x.com/waaiiobot',
  ],
  areaServed: [
    { '@type': 'Country', name: 'United States' },
    { '@type': 'Country', name: 'Canada' },
    { '@type': 'Country', name: 'Nigeria' },
    { '@type': 'Country', name: 'Ghana' },
    { '@type': 'Country', name: 'United Kingdom' },
  ],
  knowsAbout: [
    'WhatsApp Business API', 'Business automation', 'AI chatbots',
    'Payment processing', 'Appointment scheduling', 'Online ordering',
  ],
};

const JSON_LD_APP = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Waaiio',
  applicationCategory: 'BusinessApplication',
  applicationSubCategory: 'WhatsApp Automation Platform',
  operatingSystem: 'Web',
  url: baseUrl,
  description: `Automate bookings, payments, orders, donations, and tickets on WhatsApp for ${CATEGORY_COUNT}+ industries`,
  featureList: 'Appointment booking, Payment processing, Online ordering, Event ticketing, Donation collection, Customer chat, Feedback surveys, Loyalty programs, Queue management, Invoice generation, E-signatures',
  offers: [
    { '@type': 'Offer', name: 'Starter', price: '0', priceCurrency: 'USD', description: 'Free plan with 30-day trial', availability: 'https://schema.org/InStock' },
    { '@type': 'Offer', name: 'Pro', price: '14.99', priceCurrency: 'USD', description: 'Growth plan for scaling businesses', availability: 'https://schema.org/InStock' },
    { '@type': 'Offer', name: 'Premium', price: '39.99', priceCurrency: 'USD', description: 'Full platform with white-label branding', availability: 'https://schema.org/InStock' },
  ],
  creator: { '@type': 'Organization', name: 'Waaiio', url: baseUrl },
};

const FAQ_DATA = [
  { question: 'What types of businesses can use Waaiio?', answer: `Any business or organisation that wants WhatsApp automation — salons, barbers, spas, churches, mosques, schools, NGOs, clinics, shops, event companies, hotels, restaurants, pharmacies, and much more. We support ${CATEGORY_COUNT}+ categories.` },
  { question: 'Is there really a free plan?', answer: 'Yes! Start with our Starter plan — 30-day free trial with zero fees, then a small per-transaction fee. No monthly subscription required. No credit card needed.' },
  { question: 'How do payments work?', answer: 'When a customer needs to pay, they receive a secure payment link in the chat. We support Paystack (Nigeria, Ghana), Stripe (US, UK, Canada), Square (US), Flutterwave (Africa), and PayPal (US, UK, Canada). Funds go directly to your account.' },
  { question: 'Do I need a developer to set this up?', answer: 'No. Sign up, add your services, and connect your WhatsApp — your bot is live in under 5 minutes. Everything is managed from a simple dashboard.' },
  { question: 'Can I use my own WhatsApp number?', answer: 'Yes! You can use your existing business WhatsApp number (dedicated) or use our shared number to get started instantly. Switch to your own number anytime.' },
  { question: 'Can I customise the messages?', answer: 'Yes. You can set a custom assistant name, greeting, and personality that matches your brand. Premium-tier users get full white-label branding.' },
  { question: 'What happens outside operating hours?', answer: 'The automation works 24/7 — it will take bookings and orders even at 2 AM. You can set operating hours so only available time slots are offered.' },
  { question: 'What languages does the bot support?', answer: 'The bot speaks English, Pidgin, Yoruba, Igbo, Hausa, Twi, and French. Customers can chat naturally in their preferred language — the AI understands and responds accordingly.' },
  { question: 'Is there a long-term contract?', answer: 'No. All plans are month-to-month with no lock-in. You can upgrade, downgrade, or cancel at any time.' },
  { question: 'Is my data secure?', answer: 'Yes. We use bank-grade encryption, all webhooks are signature-verified, and your data is isolated per business. We are a Meta Verified Technology Provider and follow GDPR-compliant data practices.' },
];

const JSON_LD_FAQ = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ_DATA.map((item) => ({
    '@type': 'Question',
    name: item.question,
    acceptedAnswer: { '@type': 'Answer', text: item.answer },
  })),
};

const JSON_LD_WEBSITE = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Waaiio',
  url: baseUrl,
  description: 'AI-Powered WhatsApp Automation for Every Business',
  potentialAction: {
    '@type': 'SearchAction',
    target: { '@type': 'EntryPoint', urlTemplate: `${baseUrl}/directory?search={search_term_string}` },
    'query-input': 'required name=search_term_string',
  },
};

export default async function HomePage() {
  // Fetch real stats from DB (server-side, cached for 5 min)
  let stats = { businesses: '25+', payments: '95+', countries: '5' };
  try {
    const supabase = createServiceClient();
    const [{ count: bizCount }, { count: payCount }, { data: countryData }] = await Promise.all([
      supabase.from('businesses').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('payments').select('id', { count: 'exact', head: true }).eq('status', 'success'),
      supabase.from('businesses').select('country_code').eq('status', 'active'),
    ]);
    const uniqueCountries = new Set((countryData || []).map(b => b.country_code)).size;
    stats = {
      businesses: `${bizCount || 25}+`,
      payments: `${payCount || 95}+`,
      countries: String(uniqueCountries || 5),
    };
  } catch {}

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_ORG) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_APP) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_FAQ) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_WEBSITE) }} />
      <HomeClient stats={stats} />
    </>
  );
}
