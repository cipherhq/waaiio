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
    answer: `Any business or organisation that wants WhatsApp automation — salons, barbers, spas, churches, mosques, schools, NGOs, clinics, shops, event companies, hotels, restaurants, pharmacies, and much more. We support ${CATEGORY_COUNT}+ categories.`,
  },
  {
    question: 'Is there really a free plan?',
    answer: 'Yes! Start with our Starter plan — 30-day free trial with zero fees, then a small per-transaction fee. No monthly subscription required. No credit card needed.',
  },
  {
    question: 'How do payments work?',
    answer: 'When a customer needs to pay, they receive a secure payment link in the chat. We support Paystack (Nigeria, Ghana), Stripe (US, UK, Canada), Square (US), Flutterwave (Africa), and PayPal (US, UK, Canada). Funds go directly to your account.',
  },
  {
    question: 'Do I need a developer to set this up?',
    answer: 'No. Sign up, add your services, and connect your WhatsApp — your bot is live in under 5 minutes. Everything is managed from a simple dashboard.',
  },
  {
    question: 'Can I use my own WhatsApp number?',
    answer: 'Yes! You can use your existing business WhatsApp number (dedicated) or use our shared number to get started instantly. Switch to your own number anytime.',
  },
  {
    question: 'Can I customise the messages?',
    answer: 'Yes. You can set a custom assistant name, greeting, and personality that matches your brand. Premium-tier users get full white-label branding.',
  },
  {
    question: 'What happens outside operating hours?',
    answer: 'The automation works 24/7 — it will take bookings and orders even at 2 AM. You can set operating hours so only available time slots are offered.',
  },
  {
    question: 'What languages does the bot support?',
    answer: 'The bot speaks English, Pidgin, Yoruba, Igbo, Hausa, Twi, and French. Customers can chat naturally in their preferred language — the AI understands and responds accordingly.',
  },
  {
    question: 'Is there a long-term contract?',
    answer: 'No. All plans are month-to-month with no lock-in. You can upgrade, downgrade, or cancel at any time.',
  },
  {
    question: 'Is my data secure?',
    answer: 'Yes. We use bank-grade encryption, all webhooks are signature-verified, and your data is isolated per business. We are a Meta Verified Technology Provider and follow GDPR-compliant data practices.',
  },
];


const PRICE_COUNTRIES = [
  { code: 'NG' as const, flag: '🇳🇬', label: 'Nigeria' },
  { code: 'US' as const, flag: '🇺🇸', label: 'US' },
  { code: 'GB' as const, flag: '🇬🇧', label: 'UK' },
  { code: 'CA' as const, flag: '🇨🇦', label: 'Canada' },
  { code: 'GH' as const, flag: '🇬🇭', label: 'Ghana' },
];

export default function HomeClient({ stats }: { stats?: { businesses: string; payments: string; countries: string } }) {
  useCategoryConfig();
  const { scrollYProgress } = useScroll();
  const heroY = useTransform(scrollYProgress, [0, 0.3], [0, 120]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.2], [1, 0]);
  const [priceCountry, setPriceCountry] = useState<'NG' | 'US' | 'GB' | 'CA' | 'GH'>('NG');
  const PRICING_TIERS = getPricingTiers(priceCountry);

  return (
    <>
      {/* Scroll progress bar */}
      <motion.div
        className="fixed top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-brand via-accent to-brand z-[60] origin-left"
        style={{ scaleX: scrollYProgress }}
      />

      {/* ── 1. Hero ── */}
      <section className="relative min-h-screen overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700">
        {/* Decorative blobs */}
        <motion.div style={{ y: heroY }} className="pointer-events-none absolute inset-0">
          <div className="absolute -left-20 -top-20 h-[250px] w-[250px] sm:-left-40 sm:-top-40 sm:h-[500px] sm:w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
          <div className="absolute -bottom-16 right-0 h-[200px] w-[200px] sm:-bottom-32 sm:h-[400px] sm:w-[400px] rounded-full bg-accent/10 blur-3xl" />
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
                Just message. It understands.
              </motion.span>

              <h1 className="mt-6 text-balance text-4xl font-extrabold leading-[1.1] tracking-tight text-white sm:text-5xl lg:text-[3.5rem]">
                {'Customers Book & Pay'.split(' ').map((word, i) => (
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
                {'on '.split(' ').map((word, i) => (
                  <motion.span
                    key={`w2-${i}`}
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.5 + i * 0.07, duration: 0.5 }}
                    className="inline-block mr-[0.25em]"
                  >
                    {word}
                  </motion.span>
                ))}
                <motion.span
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.6, duration: 0.5 }}
                  className="inline-block text-accent mr-[0.25em]"
                >
                  WhatsApp
                </motion.span>
                <motion.span
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.7, duration: 0.5 }}
                  className="inline-block"
                >
                  &mdash; While You Sleep.
                </motion.span>
              </h1>

              <motion.p
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.9, duration: 0.6 }}
                className="mx-auto mt-5 max-w-lg text-lg leading-relaxed text-brand-200 lg:mx-0"
              >
                Your customers type &ldquo;book me for Friday at 2pm&rdquo; and it just works. Bookings, payments, orders, tickets &mdash; all on WhatsApp, all automatic.
              </motion.p>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1.1, duration: 0.6 }}
                className="mt-8 flex flex-wrap justify-center gap-3 lg:justify-start"
              >
                <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }}>
                  <Link
                    href="/get-started"
                    className="rounded-2xl bg-accent px-8 py-4 text-base font-bold text-gray-900 shadow-xl shadow-accent/30 transition hover:bg-accent-400 hover:shadow-accent/50"
                  >
                    Get Started Free
                  </Link>
                </motion.div>
                <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }}>
                  <Link
                    href="/pricing"
                    className="rounded-2xl border border-white/20 bg-white/5 px-6 py-4 text-sm font-medium text-white/90 backdrop-blur transition hover:bg-white/15"
                  >
                    View Pricing
                  </Link>
                </motion.div>
                <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }}>
                  <a
                    href="https://wa.me/12029226251?text=Hi"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-2xl bg-whatsapp/90 px-5 py-3.5 text-sm font-semibold text-white transition hover:bg-whatsapp"
                  >
                    <svg aria-hidden="true" className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                    Try on WhatsApp
                  </a>
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
                  {[
                    { initials: 'AO', gradient: 'from-brand-400 to-brand-600' },
                    { initials: 'CK', gradient: 'from-accent-400 to-accent-600' },
                    { initials: 'GN', gradient: 'from-green-400 to-emerald-600' },
                    { initials: 'TJ', gradient: 'from-blue-400 to-indigo-600' },
                    { initials: 'FA', gradient: 'from-pink-400 to-rose-600' },
                  ].map((a, i) => (
                    <div key={i} className={`flex h-8 w-8 items-center justify-center rounded-full border-2 border-brand-900 bg-gradient-to-br ${a.gradient} text-[10px] font-bold text-white`}>
                      {a.initials}
                    </div>
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
                  <p className="text-xs text-brand-200">Trusted by businesses across <strong className="text-white">5 countries</strong></p>
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
            <svg aria-hidden="true" className="h-7 w-7 text-white/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              <svg aria-hidden="true" className="h-5 w-5 text-[#25D366]" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
              </svg>
              <span className="text-sm font-semibold text-gray-700">WhatsApp Business Platform</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Trust Signals ── */}
      <section className="border-b border-gray-100 bg-white py-8">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-8 px-4 sm:gap-14">
          {[
            { value: '89+', label: 'Business Types Supported' },
            { value: '5', label: 'Countries Live' },
            { value: '30', label: 'Capabilities Built In' },
            { value: '24/7', label: 'Always On' },
          ].map(s => (
            <div key={s.label} className="text-center">
              <p className="text-3xl font-black tracking-tight text-gray-900">{s.value}</p>
              <p className="mt-0.5 text-xs font-medium text-gray-400">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Payment Partners Trust Bar ── */}
      <section className="border-b border-gray-100 bg-white py-6">
        <div className="mx-auto max-w-4xl px-4 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-300 mb-4">Payments powered by</p>
          <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-12">
            {[
              { name: 'Stripe', letter: 'S', color: '#635BFF' },
              { name: 'Paystack', letter: 'P', color: '#00C3F7' },
              { name: 'Square', letter: 'Sq', color: '#3E4348' },
              { name: 'Flutterwave', letter: 'F', color: '#F5A623' },
              { name: 'PayPal', letter: 'PP', color: '#003087' },
            ].map(g => (
              <span
                key={g.name}
                className="text-base font-extrabold tracking-tight text-gray-300 transition-colors duration-300 hover:text-gray-900"
                style={{ ['--hover-color' as string]: g.color }}
              >
                {g.name}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Live Bot Demo ── */}
      <section className="bg-gradient-to-b from-gray-50/80 to-white py-24">
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

      {/* ── How It Works — 3 Steps ── */}
      <section className="bg-white py-24">
        <div className="mx-auto max-w-5xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Simple setup</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">
              Up and running in 5 minutes
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-gray-600">
              No developers needed. No app to download. Just your WhatsApp number and a browser.
            </p>
          </AnimatedSection>

          <div className="mt-14 grid gap-8 lg:grid-cols-3">
            {[
              {
                step: '1',
                title: 'Tell us about your business',
                desc: 'Add your services, prices, and hours. We set up the bot to match your industry — salon, church, restaurant, clinic, or any of 40+ categories.',
                icon: '&#x1F4DD;',
              },
              {
                step: '2',
                title: 'Connect WhatsApp',
                desc: 'Use your own number or start with ours. Your bot goes live instantly — no coding, no waiting, no approval needed.',
                icon: '&#x1F4F1;',
              },
              {
                step: '3',
                title: 'Customers start messaging',
                desc: 'They type naturally — "book me for Friday" or "I wan order food" — and the bot handles it. You just watch the bookings roll in.',
                icon: '&#x1F680;',
              },
            ].map((s, i) => (
              <AnimatedSection key={s.step} delay={i * 0.1}>
                <motion.div
                  whileHover={{ y: -4 }}
                  className="relative rounded-2xl border border-gray-100 bg-white p-8 text-center shadow-sm transition-shadow hover:shadow-xl hover:shadow-brand/5"
                >
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-50 to-brand-100">
                    <span className="text-2xl" dangerouslySetInnerHTML={{ __html: s.icon }} />
                  </div>
                  <div className="mt-2 text-[10px] font-bold uppercase tracking-[0.2em] text-brand/60">Step {s.step}</div>
                  <h3 className="mt-3 text-lg font-semibold text-gray-900">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-500">{s.desc}</p>
                  {i < 2 && (
                    <div className="absolute -right-4 top-1/2 hidden text-2xl text-gray-200 lg:block">&rarr;</div>
                  )}
                </motion.div>
              </AnimatedSection>
            ))}
          </div>

          <AnimatedSection delay={0.3} className="mt-10 text-center">
            <Link
              href="/get-started"
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-8 py-3 text-sm font-bold text-white shadow-lg shadow-brand/25 transition hover:bg-brand-600"
            >
              Start Free — No Credit Card
              <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
            </Link>
          </AnimatedSection>
        </div>
      </section>

      {/* ── Talk Naturally — NL Examples ── */}
      <section className="bg-gray-950 py-20">
        <div className="mx-auto max-w-5xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand-300">No menus. No buttons. Just talk.</p>
            <h2 className="mt-3 text-3xl font-bold text-white sm:text-4xl">
              Your customers already know how to use it
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-gray-400">
              They just type what they want — in their own words, their own language. The bot figures out the rest.
            </p>
          </AnimatedSection>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { msg: 'Book me for Friday at 3pm', result: 'Service, date & time auto-filled → straight to confirmation', tag: 'Booking' },
              { msg: 'I wan barb tomorrow morning', result: 'Pidgin understood → haircut matched → morning slots shown', tag: 'Pidgin' },
              { msg: 'Pay tithe 5000', result: 'Category matched → amount filled → payment link sent', tag: 'Payment' },
              { msg: 'Order 2 jollof rice', result: 'Product matched → quantity set → skips to checkout', tag: 'Ordering' },
              { msg: 'Reorder', result: 'Last order loaded into cart → ready to pay', tag: 'Repeat' },
              { msg: 'Buy 2 tickets for the concert', result: 'Event matched → 2 tickets → QR codes sent after payment', tag: 'Tickets' },
            ].map((ex, i) => (
              <AnimatedSection key={ex.msg} delay={i * 0.06}>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                  <span className="inline-block rounded-full bg-brand/20 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-brand-300">{ex.tag}</span>
                  <p className="mt-3 text-base font-semibold text-white">&ldquo;{ex.msg}&rdquo;</p>
                  <p className="mt-2 text-sm text-gray-400">{ex.result}</p>
                </div>
              </AnimatedSection>
            ))}
          </div>

          <AnimatedSection delay={0.4} className="mt-10 text-center">
            <p className="text-sm text-gray-500">
              Works in English, Pidgin, Yoruba, Igbo, Hausa, Twi, and French.
            </p>
          </AnimatedSection>
        </div>
      </section>

      {/* ── How Waaiio Empowers You ── */}
      <section className="bg-gray-50/60 py-24">
        <div className="mx-auto max-w-6xl px-4 text-center">
          <AnimatedSection>
            <p className="text-xs font-bold uppercase tracking-widest text-brand">What your bot can do</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">
              Customers just talk. It just works.
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-gray-600">
              No menus to learn. No apps to download. Your customers message in their own words &mdash; in English, Pidgin, Yoruba, or any of 7 languages &mdash; and the bot understands what they need.
            </p>
          </AnimatedSection>

          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { icon: '&#x1F4AC;', title: 'Understands How People Talk', desc: 'Customer types "book me for Friday at 3pm" or "I wan barb tomorrow morning" — the bot gets it. No buttons needed. Natural conversation in 7 languages.' },
              { icon: '&#x1F4C5;', title: 'Books While You Sleep', desc: 'A customer messages at 11 PM? Booked. Paid. Confirmed. Receipt sent. You wake up to money in your account and a full schedule.' },
              { icon: '&#x1F9E0;', title: 'Knows Your Regulars', desc: '"Welcome back, Chioma! Last time you had Full Grooming. Same thing?" The bot remembers every customer and picks up where they left off.' },
              { icon: '&#x1F4B0;', title: 'Collects Payment in Chat', desc: '"Pay tithe 5000" → payment link → confirmed in seconds. Works with Paystack, Stripe, Square, Flutterwave, and PayPal across 5 countries.' },
              { icon: '&#x1F504;', title: 'One-Word Reorders', desc: 'Returning customer types "reorder" → last order loaded → checkout. No browsing, no repeating. Two taps and done.' },
              { icon: '&#x1F514;', title: 'Cuts No-Shows by 60%', desc: 'Automatic reminders the day before. Follow-ups after every visit. Win-back messages when regulars go quiet. All hands-free.' },
              { icon: '&#x1F3C6;', title: 'Loyalty Without an App', desc: 'Points after every visit. Referral bonuses for bringing friends. Customers earn and redeem right in WhatsApp — no download, no sign-up.' },
              { icon: '&#x1F3AB;', title: 'Tickets with QR Codes', desc: 'Sell event tickets on WhatsApp. Customers get instant QR codes + PDF tickets. Scan at the door. Real-time sales tracking on your dashboard.' },
              { icon: '&#x1F4E2;', title: 'Broadcast to the Right People', desc: 'Promo to your VIPs. Win-back offer to customers who haven\'t returned. Announcement to everyone. You pick who hears what.' },
            ].map((f, i) => (
              <AnimatedSection key={f.title} delay={i * 0.06}>
                <motion.div
                  whileHover={{ y: -6, boxShadow: '0 25px 50px rgba(108,43,217,0.1)' }}
                  className="group rounded-2xl border border-gray-100 bg-white p-6 text-left transition-all duration-200 hover:border-brand/20"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-brand-100/50 transition-transform duration-200 group-hover:scale-110">
                    <span className="text-2xl" dangerouslySetInnerHTML={{ __html: f.icon }} />
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-gray-900">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-500">{f.desc}</p>
                </motion.div>
              </AnimatedSection>
            ))}
          </div>
        </div>
      </section>

      {/* ── The Problem — Why Businesses Need This ── */}
      <section className="bg-white py-24">
        <div className="mx-auto max-w-5xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-red-500">The problem</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">
              Your business is losing money right now
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-gray-600">
              Every missed call, ignored DM, and forgotten follow-up is revenue walking out the door.
            </p>
          </AnimatedSection>

          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { stat: '40%', label: 'of booking requests come after hours', desc: 'Customers message at 11 PM. You reply at 9 AM. They already booked somewhere else.', icon: '🌙' },
              { stat: '67%', label: 'of customers won\'t call back', desc: 'If they message and don\'t get an instant reply, they move on. No second chances.', icon: '📱' },
              { stat: '5hrs', label: 'wasted weekly on manual booking', desc: 'Checking availability, confirming times, sending reminders, chasing payments — all by hand.', icon: '⏰' },
              { stat: '30%', label: 'no-show rate without reminders', desc: 'Customers forget. Without automated reminders, nearly a third of appointments are wasted slots.', icon: '👻' },
              { stat: '₦0', label: 'earned from dormant customers', desc: 'You have hundreds of past customers. Without follow-ups, they never come back.', icon: '💤' },
              { stat: '3x', label: 'more effort to collect payments', desc: 'Invoicing, chasing bank transfers, reconciling manually. Payment should take 10 seconds, not 3 days.', icon: '💸' },
            ].map((item, i) => (
              <AnimatedSection key={item.label} delay={i * 0.06}>
                <div className="rounded-2xl border border-red-100 bg-red-50/50 p-6">
                  <span className="text-2xl">{item.icon}</span>
                  <p className="mt-3 text-2xl font-extrabold text-red-600">{item.stat}</p>
                  <p className="text-sm font-semibold text-gray-900">{item.label}</p>
                  <p className="mt-2 text-sm text-gray-600">{item.desc}</p>
                </div>
              </AnimatedSection>
            ))}
          </div>

          <AnimatedSection delay={0.4} className="mt-12 text-center">
            <p className="text-lg font-semibold text-gray-900">
              Waaiio fixes all of this — automatically, on WhatsApp, 24/7.
            </p>
            <p className="mt-2 text-sm text-gray-500">No app download. No website needed. Just WhatsApp.</p>
          </AnimatedSection>
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

      {/* ── Comparison Table ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-4xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Compare</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">
              WhatsApp Business vs. Waaiio
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-gray-600">
              WhatsApp Business gives you the basics. Waaiio gives you a full business operating system.
            </p>
          </AnimatedSection>

          <AnimatedSection delay={0.1}>
            {/* Mobile: card-based comparison */}
            <div className="mt-12 space-y-3 sm:hidden">
              <div className="rounded-xl border border-green-200 bg-green-50 p-4">
                <h4 className="text-xs font-semibold uppercase text-green-700 mb-3">Both WhatsApp Business & Waaiio</h4>
                <ul className="space-y-2 text-sm text-gray-700">
                  {['Business profile & hours', 'Product catalog', 'Quick replies', 'Away message', 'Greeting message', 'Broadcast lists'].map(f => (
                    <li key={f} className="flex items-center gap-2"><span className="text-green-500">&#10003;</span> {f}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl border border-brand/20 bg-brand-50 p-4">
                <h4 className="text-xs font-semibold uppercase text-brand mb-3">Only with Waaiio</h4>
                <ul className="space-y-2 text-sm text-gray-700">
                  {[
                    'AI conversation handling 24/7', 'Accept bookings with calendar & slots',
                    'Collect payments (5 gateways, 5 countries)', 'Automatic reminders before appointments',
                    'Customer memory & repeat booking', 'Generate receipts & invoices',
                    'E-signatures & contracts', 'Loyalty & referral programs',
                    'Event tickets with QR codes', 'Queue & waitlist management',
                    'Multi-language (7 languages)', 'Order management & delivery tracking',
                    'Recurring payments & subscriptions', 'Dashboard with analytics',
                    'Staff management', 'Split payments & automated payouts',
                  ].map(f => (
                    <li key={f} className="flex items-center gap-2"><span className="text-brand font-bold">&#10003;</span> {f}</li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Desktop: comparison table */}
            <div className="mt-12 hidden sm:block overflow-x-auto rounded-2xl border border-gray-200">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="px-5 py-4 font-medium text-gray-500">Feature</th>
                    <th className="px-4 py-4 text-center font-medium text-gray-500">WhatsApp Business</th>
                    <th className="px-4 py-4 text-center font-medium text-brand">Waaiio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {/* What WhatsApp Business already does */}
                  {[
                    ['Business profile & hours', true, true],
                    ['Product catalog', true, true, 'Display only', '+ Cart & checkout'],
                    ['Quick replies', true, true, 'Saved text', '+ AI-powered'],
                    ['Away message', true, true, 'Single reply', '+ Full 24/7 AI'],
                    ['Greeting message', true, true, 'Generic', '+ Personalized'],
                    ['Broadcast lists', true, true, 'Max 256', 'Unlimited'],
                  ].map(([feature, wa, waaiio, waNote, waaNote], i) => (
                    <tr key={i} className="bg-green-50/30">
                      <td className="px-5 py-3 text-gray-700">{feature as string}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-green-500">&#10003;</span>
                        {waNote && <span className="block text-[10px] text-gray-400">{waNote as string}</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-green-500 font-bold">&#10003;</span>
                        {waaNote && <span className="block text-[10px] text-brand">{waaNote as string}</span>}
                      </td>
                    </tr>
                  ))}
                  {/* What only Waaiio does */}
                  {[
                    'AI conversation handling 24/7',
                    'Accept bookings with calendar & slots',
                    'Collect payments (5 gateways, 5 countries)',
                    'Automatic reminders before appointments',
                    'Customer memory & repeat booking',
                    'Generate receipts & invoices',
                    'E-signatures & contracts',
                    'Loyalty & referral programs',
                    'Event tickets with QR codes',
                    'Queue & waitlist management',
                    'Multi-language (7 languages)',
                    'Order management & delivery tracking',
                    'Recurring payments & subscriptions',
                    'Dashboard with analytics',
                    'Staff management',
                    'Split payments & automated payouts',
                  ].map((feature, i) => (
                    <tr key={`w-${i}`} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                      <td className="px-5 py-3 text-gray-700">{feature}</td>
                      <td className="px-4 py-3 text-center"><span className="text-gray-300">&#10007;</span></td>
                      <td className="px-4 py-3 text-center"><span className="text-green-500 font-bold">&#10003;</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AnimatedSection>
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
      <section id="faq" className="bg-white py-24">
        <div className="mx-auto max-w-3xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">FAQ</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">Frequently Asked Questions</h2>
            <p className="mt-2 text-gray-500">Everything you need to know about Waaiio</p>
          </AnimatedSection>
          <div className="mt-10">
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
                  Join businesses across 5 countries already saving time and growing revenue
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
            <svg aria-hidden="true" className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
  const gradients = ['from-brand to-brand-600', 'from-accent to-accent-600', 'from-emerald-500 to-green-600', 'from-blue-500 to-indigo-600', 'from-pink-500 to-rose-600', 'from-purple-500 to-violet-600'];
  const grad = gradients[name.charCodeAt(0) % gradients.length];
  return (
    <motion.div
      whileHover={{ y: -4 }}
      className="flex min-w-[80vw] sm:min-w-[280px] flex-col rounded-2xl border border-gray-100 bg-white p-6 shadow-sm transition-all duration-200 hover:shadow-lg hover:shadow-brand/5 lg:min-w-0"
    >
      <div className="mb-4 flex items-center justify-between">
        <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand">{stat}</span>
        <span className="text-3xl font-black bg-gradient-to-br from-brand/10 to-brand/5 bg-clip-text text-transparent">{metric}</span>
      </div>
      <p className="flex-1 text-sm leading-relaxed text-gray-600">&ldquo;{quote}&rdquo;</p>
      <div className="mt-5 flex items-center gap-3 border-t border-gray-50 pt-4">
        <div className={`flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br ${grad} text-xs font-bold text-white ring-2 ring-white`}>
          {name.charAt(0)}
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-900">{name}</p>
          <p className="text-xs text-gray-400">{role}</p>
        </div>
      </div>
    </motion.div>
  );
}


function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`border-b border-gray-100 transition-colors duration-200 ${open ? 'bg-brand-50/30' : ''}`}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-4 px-4 py-5 text-left"
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
        <p className="px-4 pb-2 text-sm leading-relaxed text-gray-500">{answer}</p>
      </motion.div>
    </div>
  );
}
