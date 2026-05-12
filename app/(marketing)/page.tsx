'use client';

import Link from 'next/link';
import { useState, lazy, Suspense } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
import AnimatedSection from '@/components/marketing/AnimatedSection';
import CounterAnimation from '@/components/marketing/CounterAnimation';
import HeroAutomationFlow from '@/components/marketing/HeroAutomationFlow';
import { formatCurrency, getPricingTiers } from '@/lib/constants';
import { getCategoryList } from '@/lib/categoryConfig';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';

// Lazy load heavy below-fold components
const LiveBotDemo = lazy(() => import('@/components/marketing/LiveBotDemo'));

const DEFAULT_PRICING = getPricingTiers('NG');
const CATEGORY_COUNT = getCategoryList().filter(c => c.key !== 'other').length;

const FAQ_DATA = [
  {
    question: 'What types of businesses can use Waaiio?',
    answer: `Any business or organisation that wants WhatsApp automation — restaurants, barbers, spas, churches, mosques, schools, NGOs, clinics, shops, event companies, hotels, pharmacies, and much more. We support ${CATEGORY_COUNT}+ categories with 4 automation flows.`,
  },
  {
    question: 'Is there really a free plan?',
    answer: 'Yes! Start with our Free plan — 30-day trial with zero fees, then a small per-transaction fee. No monthly subscription required.',
  },
  {
    question: 'How do payments work?',
    answer: 'When a customer needs to pay, they receive a secure payment link in the chat via Paystack (Nigeria, Ghana), Square (US), or Stripe (UK, Canada). Funds go directly to your account.',
  },
  {
    question: 'Can I customise the messages?',
    answer: 'Yes. You can set a custom assistant name, greeting, and personality that matches your brand. Business-tier users get full white-label.',
  },
  {
    question: 'What happens outside operating hours?',
    answer: 'The automation works 24/7 — it will take bookings and orders even at 2 AM. You can set operating hours so only available time slots are offered.',
  },
  {
    question: 'Is there a long-term contract?',
    answer: 'No. All plans are month-to-month with no lock-in. You can upgrade, downgrade, or cancel at any time.',
  },
];

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

const JSON_LD_ORG = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Waaiio',
  url: baseUrl,
  logo: `${baseUrl}/logo.png`,
  description: 'AI-Powered WhatsApp Automation for Every Business',
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
  },
};

const JSON_LD_APP = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Waaiio',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web',
  url: baseUrl,
  description: 'Automate bookings, payments, orders, donations, and tickets on WhatsApp for 40+ industries',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
    description: 'Free plan with 30-day trial',
  },
  aggregateRating: {
    '@type': 'AggregateRating',
    ratingValue: '5',
    ratingCount: '100',
    bestRating: '5',
  },
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

const PRICE_COUNTRIES = [
  { code: 'NG' as const, flag: '🇳🇬', label: 'Nigeria' },
  { code: 'US' as const, flag: '🇺🇸', label: 'US' },
  { code: 'GB' as const, flag: '🇬🇧', label: 'UK' },
  { code: 'CA' as const, flag: '🇨🇦', label: 'Canada' },
  { code: 'GH' as const, flag: '🇬🇭', label: 'Ghana' },
  { code: 'IN' as const, flag: '🇮🇳', label: 'India' },
];

export default function HomePage() {
  useCategoryConfig();
  const { scrollYProgress } = useScroll();
  const heroY = useTransform(scrollYProgress, [0, 0.3], [0, 120]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.2], [1, 0]);
  const [priceCountry, setPriceCountry] = useState<'NG' | 'US' | 'GB' | 'CA' | 'GH' | 'IN'>('NG');
  const PRICING_TIERS = getPricingTiers(priceCountry);

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_ORG) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_APP) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_FAQ) }} />
      {/* ── 1. Hero ── */}
      <section className="relative min-h-screen overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700">
        {/* Decorative blobs */}
        <motion.div style={{ y: heroY }} className="pointer-events-none absolute inset-0">
          <div className="absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
          <div className="absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        </motion.div>

        <motion.div style={{ opacity: heroOpacity }} className="relative mx-auto flex min-h-screen max-w-6xl items-center px-4 pt-16">
          <div className="grid w-full items-center gap-12 lg:grid-cols-2">
            {/* Left: Copy */}
            <div className="text-center lg:text-left">
              <motion.span
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.6 }}
                className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-sm font-medium text-white backdrop-blur"
              >
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
                </span>
                Every message handled. Every opportunity captured.
              </motion.span>

              <h1 className="mt-6 text-balance text-4xl font-extrabold leading-tight text-white sm:text-5xl lg:text-[3.5rem]">
                {'Your WhatsApp. '.split(' ').map((word, i) => (
                  <motion.span
                    key={i}
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 + i * 0.07, duration: 0.5 }}
                    className="inline-block mr-[0.25em]"
                  >
                    {word}
                  </motion.span>
                ))}
                <br />
                <motion.span
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5, duration: 0.5 }}
                  className="inline-block mr-[0.25em]"
                >
                  Now
                </motion.span>
                <motion.span
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.6, duration: 0.5 }}
                  className="inline-block text-accent mr-[0.25em]"
                >
                  10x
                </motion.span>
                <motion.span
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.7, duration: 0.5 }}
                  className="inline-block"
                >
                  Smarter.
                </motion.span>
              </h1>

              <motion.p
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.9, duration: 0.6 }}
                className="mx-auto mt-5 max-w-lg text-lg leading-relaxed text-brand-200 lg:mx-0"
              >
                Automate bookings, payments, orders, and engagement on WhatsApp — for any business, any industry, any country.
              </motion.p>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1.1, duration: 0.6 }}
                className="mt-8 flex flex-wrap justify-center gap-3 lg:justify-start"
              >
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                  <Link
                    href="/get-started"
                    className="rounded-xl bg-accent px-7 py-3.5 text-sm font-bold text-gray-900 shadow-lg shadow-accent/25 transition hover:bg-accent-400 hover:shadow-accent/40"
                  >
                    Get Started Free
                  </Link>
                </motion.div>
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                  <Link
                    href="/pricing"
                    className="rounded-xl border border-white/30 px-7 py-3.5 text-sm font-semibold text-white transition hover:bg-white/10"
                  >
                    View Pricing
                  </Link>
                </motion.div>
              </motion.div>

              {/* Social proof mini */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1.3, duration: 0.6 }}
                className="mt-8 flex items-center justify-center gap-4 lg:justify-start"
              >
                <div className="flex -space-x-2">
                  {['bg-brand-300', 'bg-accent', 'bg-green-400', 'bg-blue-400', 'bg-pink-400'].map((c, i) => (
                    <div key={i} className={`h-8 w-8 rounded-full border-2 border-brand-900 ${c}`} />
                  ))}
                </div>
                <div className="text-left">
                  <div className="flex items-center gap-1 text-accent">
                    {[...Array(5)].map((_, i) => (
                      <svg key={i} className="h-3.5 w-3.5 fill-current" viewBox="0 0 20 20">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    ))}
                  </div>
                  <p className="text-xs text-brand-200">Trusted by <strong className="text-white">100+</strong> businesses</p>
                </div>
              </motion.div>

              {/* Meta Business Partner Badge */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1.6, duration: 0.6 }}
                className="mt-6 flex items-center justify-center gap-3 lg:justify-start"
              >
                <img src="/meta-business-partner.svg" alt="Meta Business Partner" className="h-8 brightness-0 invert opacity-80" />
              </motion.div>
            </div>

            {/* Right: Automation flow visualization */}
            <HeroAutomationFlow />
          </div>
        </motion.div>

        {/* Scroll indicator */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.5 }}
          className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2"
        >
          <motion.div
            animate={{ y: [0, 8, 0] }}
            transition={{ repeat: Infinity, duration: 1.5, ease: 'easeInOut' }}
          >
            <svg className="h-7 w-7 text-white/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </motion.div>
        </motion.div>
      </section>

      {/* ── Meta Partner Bar ── */}
      <section className="border-b border-gray-100 bg-gray-50 py-5">
        <div className="mx-auto max-w-4xl px-4 text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-gray-400 mb-4">Official Technology Partner</p>
          <div className="flex items-center justify-center gap-8">
            <img src="/meta-business-partner.svg" alt="Meta Business Partner" className="h-10" />
            <div className="flex items-center gap-2">
              <svg className="h-5 w-5 text-[#25D366]" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
              </svg>
              <span className="text-sm font-semibold text-gray-700">WhatsApp Business Platform</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Compact Stats ── */}
      <section className="border-b border-gray-100 bg-white py-6">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-6 px-4 sm:gap-10">
          {[
            { value: '100+', label: 'Businesses' },
            { value: '25K+', label: 'Transactions' },
            { value: '6', label: 'Countries' },
            { value: '24/7', label: 'Always On' },
          ].map(s => (
            <div key={s.label} className="text-center">
              <p className="text-lg font-extrabold text-gray-900 sm:text-xl">{s.value}</p>
              <p className="text-xs text-gray-400">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Live Bot Demo ── */}
      <section className="bg-gradient-to-b from-gray-50 to-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Try it yourself</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">
              See the bot in action
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-gray-600">
              Type a message below and watch the AI respond instantly. This is exactly what your customers experience.
            </p>
          </AnimatedSection>
          <AnimatedSection className="mt-12">
            <Suspense fallback={<div className="mx-auto h-[400px] max-w-md animate-pulse rounded-2xl bg-gray-100" />}>
              <LiveBotDemo />
            </Suspense>
          </AnimatedSection>
        </div>
      </section>

      {/* ── How Waaiio Empowers You ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4 text-center">
          <AnimatedSection>
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Your invisible AI layer</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">
              Everything WhatsApp Business should have been
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-gray-600">
              Use your own WhatsApp number. Customers think you just got really good at replying. Behind the scenes, AI handles everything.
            </p>
          </AnimatedSection>

          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { icon: '&#x1F4C5;', title: 'Never Miss a Booking', desc: 'Accept bookings, payments, and orders 24/7 — even when you\'re closed. Your bot works while you sleep.' },
              { icon: '&#x1F9E0;', title: 'Remembers Every Customer', desc: '"Welcome back! Last time you had a haircut + beard trim. Want the same?" Your bot personalizes every interaction based on history.' },
              { icon: '&#x1F4B0;', title: 'Collect Money Instantly', desc: 'Payments, tithes, donations, fees — collected automatically in the chat via Paystack, Stripe, Square, or Flutterwave. Receipts sent instantly.' },
              { icon: '&#x1F4C8;', title: 'AI Revenue Recommendations', desc: '"23 customers haven\'t returned in 30 days. Your evening slots are empty. Enable deposits to cut no-shows." One-click actions from your dashboard.' },
              { icon: '&#x1F514;', title: '60% Fewer No-Shows', desc: 'Automatic reminders before every appointment. Smart follow-ups after every visit. Win-back campaigns for dormant customers.' },
              { icon: '&#x1F30D;', title: '7 Languages, One Bot', desc: 'Speaks English, Pidgin, Yoruba, Igbo, Hausa, Twi, and French. Your customers talk naturally — the AI understands.' },
              { icon: '&#x1F3C6;', title: 'Loyalty That Runs Itself', desc: 'Points awarded after every visit. Referral bonuses for bringing friends. All automated through WhatsApp — no app download needed.' },
              { icon: '&#x1F4CB;', title: 'Smart Queue & Waitlist', desc: 'Customers join the queue from WhatsApp. Notified automatically when it\'s their turn. No more crowded waiting rooms.' },
              { icon: '&#x1F4E2;', title: 'Targeted Broadcasts', desc: 'Send promos to VIP customers. Win-back offers to churning ones. Announcements to everyone. Unlimited broadcasts on Business tier.' },
            ].map((f, i) => (
              <AnimatedSection key={f.title} delay={i * 0.06}>
                <motion.div
                  whileHover={{ y: -6, boxShadow: '0 20px 40px rgba(108,43,217,0.08)' }}
                  className="group rounded-2xl border border-gray-100 bg-white p-6 text-left transition hover:border-brand-200"
                >
                  <span className="text-3xl" dangerouslySetInnerHTML={{ __html: f.icon }} />
                  <h3 className="mt-4 text-base font-semibold text-gray-900">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-600">{f.desc}</p>
                </motion.div>
              </AnimatedSection>
            ))}
          </div>
        </div>
      </section>

      {/* ── WHY WAAIIO — 3 Big Cards ── */}
      <section className="bg-gray-50 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Why Waaiio?</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">
              What WhatsApp Business can&apos;t do
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-gray-600">
              WhatsApp Business gives you a catalog and quick replies. Waaiio gives you a business operating system.
            </p>
          </AnimatedSection>

          <div className="mt-14 grid gap-8 lg:grid-cols-3">
            {[
              { number: '01', title: 'Auto-Book, Auto-Pay, Auto-Receipt', desc: 'Customer messages "I wan barb tomorrow 3pm" → bot books the slot, collects payment, sends a receipt. No staff needed. WhatsApp Business can\'t do this.', color: 'brand' },
              { number: '02', title: 'Knows Your Customers', desc: '"Welcome back, Chioma! Last time you had Full Grooming. Want the same?" Your bot remembers every customer, suggests repeat bookings, and flags who\'s about to churn.', color: 'accent' },
              { number: '03', title: 'Grows Your Revenue', desc: '"23 customers haven\'t returned in 30 days — send a win-back offer?" AI-powered recommendations tell you exactly what to do to earn more. One-click actions from your dashboard.', color: 'whatsapp' },
            ].map((card, i) => (
              <AnimatedSection key={card.number} delay={i * 0.1}>
                <WhyCard {...card} />
              </AnimatedSection>
            ))}
          </div>
        </div>
      </section>

      {/* ── Industry Showcase ── */}
      <IndustryShowcase categoryCount={CATEGORY_COUNT} />

      {/* ── Testimonials ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Customer Feedback</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">
              What business owners say
            </h2>
            <p className="mt-2 text-gray-600">Real results from real businesses</p>
          </AnimatedSection>

          <div className="mt-12 flex gap-6 overflow-x-auto pb-4 lg:grid lg:grid-cols-3 lg:overflow-visible lg:pb-0">
            {[
              { quote: 'Our members can now pay tithes, offerings, and seed directly on WhatsApp. Collections are up and our admin team saves hours every week.', name: 'Pastor Grace A.', role: 'New Life Church, Abuja', stat: '5hrs saved weekly', metric: '-5hrs' },
              { quote: 'We went from missing 40% of after-hours booking requests to capturing every single one. Revenue is up 30% in 3 months.', name: 'Adebayo O.', role: "King's Cuts Barbershop, Lagos", stat: '30% more revenue', metric: '+30%' },
              { quote: 'Customers love ordering via WhatsApp instead of calling. Our average order value went up because the bot upsells naturally.', name: 'Chioma N.', role: 'Fresh Bites Delivery, PH', stat: '22% higher AOV', metric: '+22%' },
            ].map((t, i) => (
              <AnimatedSection key={t.name} delay={i * 0.1}>
                <TestimonialCard {...t} />
              </AnimatedSection>
            ))}
          </div>

          <div className="mt-6 flex gap-6 overflow-x-auto pb-4 lg:grid lg:grid-cols-3 lg:overflow-visible lg:pb-0">
            {[
              { quote: 'Zakat and sadaqah donations come in seamlessly now. The bot handles contribution categories and sends instant receipts — very professional.', name: 'Imam Yusuf K.', role: 'Al-Noor Mosque, London', stat: '40% more donations', metric: '+40%' },
              { quote: 'Parents can now check balances and pay school fees on WhatsApp. Our accounts department processes 3x more payments with zero manual entry.', name: 'Mrs. Okonkwo', role: 'Prestige Academy, Abuja', stat: '3x faster processing', metric: '3x' },
              { quote: 'We sell event tickets through WhatsApp now. Attendees get instant QR codes and we have real-time visibility on every sale.', name: 'Tunde A.', role: 'Lagos Event Co.', stat: '2x ticket sales', metric: '2x' },
            ].map((t, i) => (
              <AnimatedSection key={t.name} delay={i * 0.1}>
                <TestimonialCard {...t} />
              </AnimatedSection>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing Preview ── */}
      <section id="pricing" className="bg-gray-50 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Pricing</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">
              Simple, transparent pricing
            </h2>
            <p className="mt-2 text-gray-600">
              Start free. Upgrade when you&apos;re ready.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {PRICE_COUNTRIES.map(c => (
                <button
                  key={c.code}
                  onClick={() => setPriceCountry(c.code)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${priceCountry === c.code ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >
                  {c.flag} {c.label}
                </button>
              ))}
            </div>
          </AnimatedSection>

          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            <AnimatedSection delay={0}>
              <PlanCard
                name={PRICING_TIERS.free.name}
                price={formatCurrency(0, priceCountry)}
                period=""
                features={PRICING_TIERS.free.features}
                cta={{ label: 'Start Free', href: '/get-started' }}
              />
            </AnimatedSection>
            <AnimatedSection delay={0.1}>
              <PlanCard
                name={PRICING_TIERS.growth.name}
                price={formatCurrency(PRICING_TIERS.growth.price as number, priceCountry)}
                period="/month"
                highlight
                features={PRICING_TIERS.growth.features}
                cta={{ label: 'Get Started', href: '/get-started?plan=growth', gold: true }}
              />
            </AnimatedSection>
            <AnimatedSection delay={0.2}>
              <PlanCard
                name={PRICING_TIERS.business.name}
                price={formatCurrency(PRICING_TIERS.business.price as number, priceCountry)}
                period="/month"
                features={PRICING_TIERS.business.features}
                cta={{ label: 'Get Started', href: '/get-started?plan=business' }}
              />
            </AnimatedSection>
          </div>

          <AnimatedSection delay={0.3} className="mt-8 text-center">
            <Link
              href="/pricing"
              className="text-sm font-semibold text-brand transition hover:text-brand-400"
            >
              See full pricing details with billing calculator &rarr;
            </Link>
          </AnimatedSection>
        </div>
      </section>


      {/* ── FAQ ── */}
      <section id="faq" className="bg-gray-50 py-16">
        <div className="mx-auto max-w-3xl px-4">
          <h2 className="text-center text-2xl font-bold text-gray-900">Frequently Asked Questions</h2>
          <div className="mt-8">
            {FAQ_DATA.map((item) => (
              <FaqItem key={item.question} question={item.question} answer={item.answer} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection>
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-900 via-brand to-brand-700 p-12 text-center lg:p-16">
              <div className="pointer-events-none absolute inset-0 opacity-30">
                <div className="absolute left-1/4 top-1/4 h-64 w-64 rounded-full bg-accent/20 blur-3xl" />
                <div className="absolute bottom-1/4 right-1/4 h-48 w-48 rounded-full bg-brand-300/20 blur-3xl" />
              </div>
              <div className="relative z-10">
                <h2 className="text-3xl font-bold text-white lg:text-4xl">
                  Ready to automate your business on WhatsApp?
                </h2>
                <p className="mx-auto mt-4 max-w-xl text-lg text-brand-200">
                  Join 100+ businesses already saving time and growing revenue
                  with Waaiio.
                </p>
                <div className="mt-8 flex flex-wrap justify-center gap-3">
                  <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                    <Link
                      href="/get-started"
                      className="rounded-xl bg-accent px-8 py-4 text-sm font-bold text-gray-900 shadow-lg shadow-accent/25 transition hover:bg-accent-400"
                    >
                      Get Started Free
                    </Link>
                  </motion.div>
                  <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                    <Link
                      href="/contact"
                      className="rounded-xl border border-white/30 px-8 py-4 text-sm font-semibold text-white transition hover:bg-white/10"
                    >
                      Talk to Sales
                    </Link>
                  </motion.div>
                </div>
              </div>
            </div>
          </AnimatedSection>
        </div>
      </section>
    </>
  );
}

/* ─── Local Helper Components ─── */

const FLOW_TABS = [
  { flow: 'scheduling' as const, label: 'Scheduling', icon: '\u{1F4C5}', accent: 'blue', description: 'Appointments & reservations' },
  { flow: 'payment' as const, label: 'Payments', icon: '\u{1F4B3}', accent: 'green', description: 'Tithes, fees & donations' },
  { flow: 'ordering' as const, label: 'Ordering', icon: '\u{1F6D2}', accent: 'amber', description: 'Products & delivery' },
  { flow: 'ticketing' as const, label: 'Ticketing', icon: '\u{1F3AB}', accent: 'purple', description: 'Events & transport' },
] as const;

const INDUSTRY_DESCRIPTIONS: Record<string, string> = {
  restaurant: 'Table reservations, waitlists & dining reminders',
  barber: 'Haircut & grooming appointments, walk-in queues',
  spa: 'Treatment bookings with deposit collection',
  salon: 'Styling sessions, braiding & beauty appointments',
  gym: 'Class bookings, PT sessions & membership renewals',
  clinic: 'Patient appointments, check-ups & consultations',
  consultant: 'Client consultations & strategy sessions',
  tattoo: 'Session bookings with portfolio showcase',
  real_estate: 'Property viewings & buyer consultations',
  travel_agency: 'Trip planning & itinerary bookings',
  laundry: 'Pickup scheduling & delivery tracking',
  veterinary: 'Pet check-ups, vaccinations & grooming',
  dental: 'Check-ups, cleanings & dental procedures',
  coworking: 'Desk & meeting room reservations',
  tutor: 'Private lessons & group class scheduling',
  photographer: 'Portrait & event session bookings',
  hotel: 'Room reservations & guest check-in',
  car_wash: 'Wash bookings with service selection',
  church: 'Tithes, offerings & building fund contributions',
  mosque: 'Zakat, Sadaqah & Fitrah payments',
  school: 'School fees, PTA dues & exam payments',
  ngo: 'Donations, memberships & fundraising',
  car_park: 'Hourly, daily & monthly parking passes',
  taxi: 'Ride payments & airport transfers',
  government: 'Utility bills & application fees',
  crowdfunding_org: 'Campaign donations & project funding',
  funeral: 'Memorial contributions & service fees',
  shop: 'Product catalog, cart & checkout',
  food_delivery: 'Menu ordering with delivery tracking',
  instagram_vendor: 'Custom orders & bundle deals',
  logistics: 'Shipment booking & package tracking',
  mall_vendor: 'In-store catalog & order ahead',
  pharmacy: 'Prescription orders & OTC delivery',
  catering: 'Event catering packages & party orders',
  tailor: 'Custom measurements & fashion orders',
  events: 'Event listings, ticket sales & QR codes',
  transport: 'Route tickets & seat reservations',
  cinema: 'Movie tickets & showtime selection',
};

const MAX_VISIBLE_CARDS = 9;

const ACCENT_STYLES: Record<string, {
  ring: string; shadow: string; bg: string; text: string;
  cardBg: string; cardBorder: string; iconBg: string;
}> = {
  blue:   { ring: 'ring-blue-500', shadow: 'shadow-blue-500/25', bg: 'bg-blue-500/10', text: 'text-blue-400', cardBg: 'bg-blue-500/5', cardBorder: 'border-blue-500/10', iconBg: 'bg-blue-500/15' },
  green:  { ring: 'ring-green-500', shadow: 'shadow-green-500/25', bg: 'bg-green-500/10', text: 'text-green-400', cardBg: 'bg-green-500/5', cardBorder: 'border-green-500/10', iconBg: 'bg-green-500/15' },
  amber:  { ring: 'ring-amber-500', shadow: 'shadow-amber-500/25', bg: 'bg-amber-500/10', text: 'text-amber-400', cardBg: 'bg-amber-500/5', cardBorder: 'border-amber-500/10', iconBg: 'bg-amber-500/15' },
  purple: { ring: 'ring-purple-500', shadow: 'shadow-purple-500/25', bg: 'bg-purple-500/10', text: 'text-purple-400', cardBg: 'bg-purple-500/5', cardBorder: 'border-purple-500/10', iconBg: 'bg-purple-500/15' },
};

function IndustryShowcase({ categoryCount }: { categoryCount: number }) {
  const [activeFlow, setActiveFlow] = useState<string>(FLOW_TABS[0].flow);
  const activeTab = FLOW_TABS.find(t => t.flow === activeFlow) ?? FLOW_TABS[0];
  const accent = ACCENT_STYLES[activeTab.accent];
  const industries = getCategoryList().filter(c => c.key !== 'other' && c.flow === activeFlow);

  return (
    <section className="bg-gray-950 py-20">
      <div className="mx-auto max-w-6xl px-4">
        <div className="grid items-start gap-12 lg:grid-cols-[320px_1fr]">
          <AnimatedSection direction="left" className="lg:sticky lg:top-24">
            <p className="text-xs font-bold uppercase tracking-widest text-brand-300">Built for every industry</p>
            <h2 className="mt-3 text-3xl font-bold leading-tight text-white lg:text-4xl">
              {categoryCount}+ Business Types
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-gray-400">
              Pick a flow and we auto-configure the right WhatsApp experience for your industry.
            </p>

            <div className="mt-8 flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
              {FLOW_TABS.map((tab) => {
                const isActive = tab.flow === activeFlow;
                const s = ACCENT_STYLES[tab.accent];
                return (
                  <button
                    key={tab.flow}
                    onClick={() => setActiveFlow(tab.flow)}
                    className={`flex shrink-0 items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all ${
                      isActive
                        ? `border-transparent ring-2 ${s.ring} ${s.bg} shadow-lg ${s.shadow}`
                        : 'border-white/10 bg-white/5 hover:bg-white/10'
                    }`}
                  >
                    <span className="text-xl">{tab.icon}</span>
                    <div>
                      <p className={`text-sm font-semibold ${isActive ? s.text : 'text-gray-300'}`}>{tab.label}</p>
                      <p className="text-xs text-gray-500">{tab.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </AnimatedSection>

          <div
            key={activeFlow}
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            {industries.slice(0, MAX_VISIBLE_CARDS).map((cat, i) => (
              <motion.div
                key={cat.key}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06, duration: 0.4 }}
                whileHover={{ y: -4 }}
                className={`group rounded-xl border ${accent.cardBorder} ${accent.cardBg} p-5 transition-all hover:shadow-lg hover:shadow-black/20`}
              >
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${accent.iconBg} text-xl transition-transform group-hover:scale-110`}>
                  {cat.icon}
                </div>
                <h3 className="mt-3 text-sm font-semibold text-white">{cat.label}</h3>
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  {INDUSTRY_DESCRIPTIONS[cat.key] ?? `${cat.label} automation via WhatsApp`}
                </p>
              </motion.div>
            ))}
            {industries.length > MAX_VISIBLE_CARDS && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: MAX_VISIBLE_CARDS * 0.06, duration: 0.4 }}
                className={`flex items-center justify-center rounded-xl border ${accent.cardBorder} ${accent.cardBg} p-5`}
              >
                <p className={`text-sm font-semibold ${accent.text}`}>
                  +{industries.length - MAX_VISIBLE_CARDS} more
                </p>
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}


function WhyCard({ number, title, desc, color }: { number: string; title: string; desc: string; color: string }) {
  const borderColor = color === 'brand' ? 'border-brand/20 hover:border-brand' : color === 'accent' ? 'border-accent/20 hover:border-accent' : 'border-[#25D366]/20 hover:border-[#25D366]';
  const numColor = color === 'brand' ? 'text-brand' : color === 'accent' ? 'text-accent' : 'text-[#25D366]';
  return (
    <motion.div
      whileHover={{ y: -6 }}
      className={`rounded-2xl border-2 ${borderColor} bg-white p-8 transition`}
    >
      <span className={`text-4xl font-black ${numColor} opacity-30`}>{number}</span>
      <h3 className="mt-4 text-xl font-bold text-gray-900">{title}</h3>
      <p className="mt-3 text-sm leading-relaxed text-gray-600">{desc}</p>
    </motion.div>
  );
}

function FlowCard({ emoji, title, description, industries, color }: { emoji: string; title: string; description: string; industries: string; color: string }) {
  return (
    <motion.div
      whileHover={{ y: -4 }}
      className={`rounded-2xl border ${color} p-6 transition`}
    >
      <div className="flex items-center gap-3">
        <span className="text-2xl" dangerouslySetInnerHTML={{ __html: emoji }} />
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      </div>
      <p className="mt-2 text-sm text-gray-600">{description}</p>
      <p className="mt-3 text-xs font-medium text-gray-400">{industries}</p>
    </motion.div>
  );
}

function PlanCard({ name, price, period, features, highlight, cta }: { name: string; price: string; period: string; features: string[]; highlight?: boolean; cta: { label: string; href: string; gold?: boolean } }) {
  return (
    <motion.div
      whileHover={{ y: -4 }}
      className={`flex flex-col rounded-2xl border p-6 transition ${
        highlight
          ? 'border-brand bg-brand-50/30 shadow-lg shadow-brand-50 ring-2 ring-brand'
          : 'border-gray-200 bg-white'
      }`}
    >
      {highlight && (
        <span className="mb-3 inline-block self-start rounded-full bg-brand px-3 py-0.5 text-xs font-medium text-white">
          Most Popular
        </span>
      )}
      <h3 className="text-lg font-semibold text-gray-900">{name}</h3>
      <div className="mt-3">
        <span className="text-3xl font-bold text-gray-900">{price}</span>
        {period && <span className="text-sm text-gray-500">{period}</span>}
      </div>
      <ul className="mt-6 space-y-3">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm text-gray-600">
            <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {f}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-6">
        <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
          <Link
            href={cta.href}
            className={`block rounded-xl px-4 py-3 text-center text-sm font-semibold transition ${
              cta.gold
                ? 'bg-accent text-gray-900 shadow-lg shadow-accent/20 hover:bg-accent-400'
                : highlight
                  ? 'bg-brand text-white hover:bg-brand-500'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {cta.label}
          </Link>
        </motion.div>
      </div>
    </motion.div>
  );
}

function TestimonialCard({ quote, name, role, stat, metric }: { quote: string; name: string; role: string; stat: string; metric: string }) {
  return (
    <motion.div
      whileHover={{ y: -4 }}
      className="flex min-w-[280px] flex-col rounded-2xl border border-gray-100 bg-white p-6 shadow-sm transition lg:min-w-0"
    >
      <div className="mb-4 flex items-center justify-between">
        <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand">{stat}</span>
        <span className="text-2xl font-black text-brand/20">{metric}</span>
      </div>
      <p className="flex-1 text-sm leading-relaxed text-gray-700">&ldquo;{quote}&rdquo;</p>
      <div className="mt-5 flex items-center gap-3 border-t border-gray-100 pt-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">
          {name.charAt(0)}
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-900">{name}</p>
          <p className="text-xs text-gray-500">{role}</p>
        </div>
      </div>
    </motion.div>
  );
}


function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-200 py-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-4 text-left"
      >
        <h3 className="text-sm font-semibold text-gray-900">{question}</h3>
        <motion.svg
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="h-4 w-4 shrink-0 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </motion.svg>
      </button>
      <motion.div
        initial={false}
        animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
        transition={{ duration: 0.3 }}
        className="overflow-hidden"
      >
        <p className="mt-2 text-sm leading-relaxed text-gray-600">{answer}</p>
      </motion.div>
    </div>
  );
}
