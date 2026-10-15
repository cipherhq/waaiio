import type { Metadata } from 'next';
import HomeClient from './HomeClient';
import { BRAND_NAME, WORDMARK_PATH, WORDMARK_WIDTH, WORDMARK_HEIGHT, WORDMARK_ALT } from '@/lib/brand';

export const revalidate = 60;

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

export const metadata: Metadata = {
  title: 'Waaiio — Your Business, Running on WhatsApp',
  description:
    'Customers book, order, pay, and get confirmations — just by messaging on WhatsApp. Waaiio automates bookings, payments, orders, and tickets for businesses.',
  openGraph: {
    title: 'Waaiio — Your Business, Running on WhatsApp',
    description: 'Customers book, order, pay, and get confirmations — just by messaging on WhatsApp.',
    url: baseUrl,
    siteName: 'Waaiio',
    type: 'website',
    images: [{ url: `${baseUrl}${WORDMARK_PATH}`, width: WORDMARK_WIDTH, height: WORDMARK_HEIGHT, alt: WORDMARK_ALT }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Waaiio — Your Business, Running on WhatsApp',
    description: 'Automate bookings, payments, orders & more on WhatsApp.',
    images: [`${baseUrl}${WORDMARK_PATH}`],
  },
  alternates: {
    canonical: baseUrl,
  },
};

const FAQ_DATA = [
  {
    question: 'What is Waaiio?',
    answer: 'Waaiio automates your business on WhatsApp. Customers message you to book appointments, place orders, buy tickets, and make payments — the AI handles it all, 24/7.',
  },
  {
    question: 'How do payments work?',
    answer: 'When a customer needs to pay, they receive a secure payment link in the chat. We support Stripe (US, UK, Canada) and Paystack (Nigeria, Ghana). Funds go directly to your account.',
  },
  {
    question: 'Do I need a developer?',
    answer: 'No. Add your services, connect WhatsApp, and your bot is live. Everything is managed from a simple dashboard.',
  },
  {
    question: 'Can I use my own WhatsApp number?',
    answer: 'Yes. You can use your existing business WhatsApp number or start with a shared Waaiio number. You can upgrade to a dedicated number when ready.',
  },
];

const JSON_LD_ORG = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: BRAND_NAME,
  url: baseUrl,
  logo: { '@type': 'ImageObject', url: `${baseUrl}${WORDMARK_PATH}`, width: WORDMARK_WIDTH, height: WORDMARK_HEIGHT },
  description: 'WhatsApp automation for businesses',
  foundingDate: '2026',
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'customer support',
    url: `${baseUrl}/contact`,
    email: 'hello@waaiio.com',
    availableLanguage: ['English'],
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
};

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
  description: 'WhatsApp automation for businesses',
};

const JSON_LD_APP = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Waaiio',
  applicationCategory: 'BusinessApplication',
  applicationSubCategory: 'WhatsApp Automation Platform',
  operatingSystem: 'Web',
  url: baseUrl,
  description: 'Automate bookings, payments, orders, and tickets on WhatsApp. Customers message, Waaiio gets it done.',
  featureList: 'Appointment booking, Payment processing, Online ordering, Event ticketing, Customer chat',
  creator: { '@type': 'Organization', name: 'Waaiio', url: baseUrl },
};

export default function HomePage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_ORG) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_APP) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_FAQ) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_WEBSITE) }} />
      <HomeClient faqData={FAQ_DATA} />
    </>
  );
}
