'use client';

import Link from 'next/link';
import { useState, lazy, Suspense } from 'react';
import { motion, useScroll, useTransform, useReducedMotion } from 'framer-motion';
import AnimatedSection from '@/components/marketing/AnimatedSection';
import HeroAutomationFlow from '@/components/marketing/HeroAutomationFlow';
import { formatCurrency, getPricingTiers } from '@/lib/constants';

const LiveBotDemo = lazy(() => import('@/components/marketing/LiveBotDemo'));

const PRICE_COUNTRIES = [
  { code: 'NG' as const, flag: '\u{1F1F3}\u{1F1EC}', label: 'Nigeria' },
  { code: 'US' as const, flag: '\u{1F1FA}\u{1F1F8}', label: 'US' },
  { code: 'GB' as const, flag: '\u{1F1EC}\u{1F1E7}', label: 'UK' },
  { code: 'CA' as const, flag: '\u{1F1E8}\u{1F1E6}', label: 'Canada' },
  { code: 'GH' as const, flag: '\u{1F1EC}\u{1F1ED}', label: 'Ghana' },
];

interface FaqEntry {
  question: string;
  answer: string;
}

export default function HomeClient({
  faqData,
}: {
  faqData: FaqEntry[];
}) {
  const prefersReducedMotion = useReducedMotion();
  const noMotion = !!prefersReducedMotion;
  const { scrollYProgress } = useScroll();
  const heroY = useTransform(scrollYProgress, [0, 0.3], [0, noMotion ? 0 : 80]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.25], [1, noMotion ? 1 : 0]);
  const [priceCountry, setPriceCountry] = useState<'NG' | 'US' | 'GB' | 'CA' | 'GH'>('NG');
  const tiers = getPricingTiers(priceCountry);

  // When reduced motion is preferred, entrance animations resolve immediately
  const entrance = (delay = 0) =>
    noMotion
      ? { initial: undefined, animate: undefined, transition: undefined }
      : { initial: { opacity: 0, y: 20 }, animate: { opacity: 1, y: 0 }, transition: { delay, duration: 0.6 } };

  return (
    <>
      {/* Scroll progress — hidden when reduced motion is preferred */}
      {!noMotion && (
        <motion.div
          className="fixed top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-brand via-accent to-brand z-[60] origin-left"
          style={{ scaleX: scrollYProgress }}
        />
      )}

      {/* ── 1. Hero (white bg, purple accents) ── */}
      <section className="relative min-h-[85vh] overflow-hidden bg-white">
        {/* Subtle decorative blobs */}
        <motion.div style={{ y: heroY }} className="pointer-events-none absolute inset-0">
          <div className="absolute -left-20 -top-20 h-[250px] w-[250px] sm:-left-40 sm:-top-40 sm:h-[500px] sm:w-[500px] rounded-full bg-brand-100/40 blur-3xl" />
          <div className="absolute -bottom-16 right-0 h-[200px] w-[200px] sm:-bottom-32 sm:h-[400px] sm:w-[400px] rounded-full bg-accent/10 blur-3xl" />
        </motion.div>

        <motion.div style={{ opacity: heroOpacity }} className="relative mx-auto flex min-h-[85vh] max-w-6xl items-center px-4 pt-16">
          <div className="grid w-full items-center gap-12 lg:grid-cols-2">
            <div className="text-center lg:text-left">
              <motion.span
                {...entrance(0.2)}
                className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-4 py-1.5 text-sm font-medium text-brand-700"
              >
                <span className="relative flex h-2 w-2">
                  {!noMotion && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />}
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
                </span>
                Just message. It understands.
              </motion.span>

              <motion.h1
                {...entrance(0.4)}
                className="mt-8 text-balance text-4xl font-extrabold leading-[1.08] tracking-tight text-gray-900 sm:text-5xl lg:text-[3.5rem]"
              >
                Your business,
                <br />
                running on{' '}
                <span className="text-brand">WhatsApp.</span>
              </motion.h1>

              <motion.p
                {...entrance(0.7)}
                className="mx-auto mt-6 max-w-lg text-lg leading-relaxed text-gray-500 lg:mx-0"
              >
                Customers book, order, pay, and get confirmations &mdash; just by messaging.
              </motion.p>

              <motion.div
                {...entrance(0.9)}
                className="mt-10 flex flex-wrap justify-center gap-3 lg:justify-start"
              >
                <Link
                  href="/launch"
                  className="rounded-2xl bg-brand px-7 py-3.5 text-sm font-bold text-white shadow-xl shadow-brand/20 transition hover:bg-brand-500 hover:shadow-brand/30"
                >
                  Get Launch Updates
                </Link>
                <Link
                  href="/pricing"
                  className="rounded-2xl border border-gray-200 bg-white px-7 py-3.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
                >
                  View Pricing
                </Link>
              </motion.div>
            </div>

            {/* HeroAutomationFlow has its own dark glass card */}
            <div className="rounded-3xl bg-gradient-to-br from-brand-900 via-brand to-brand-700 p-1">
              <HeroAutomationFlow />
            </div>
          </div>
        </motion.div>
      </section>

      {/* ── 2. Problem → Solution ── */}
      <section className="bg-gray-50/60 py-20">
        <div className="mx-auto max-w-5xl px-4">
          <AnimatedSection className="text-center">
            <h2 className="text-2xl font-bold text-gray-900 sm:text-3xl">
              Business shouldn&apos;t stop while someone waits for a reply.
            </h2>
          </AnimatedSection>

          <AnimatedSection className="mt-12">
            <div className="grid gap-4 sm:grid-cols-3">
              {[
                {
                  before: 'Waiting for replies',
                  after: 'Instant answers',
                  icon: '\u{26A1}',
                },
                {
                  before: 'Manual back-and-forth',
                  after: 'Automated actions',
                  icon: '\u{2699}\u{FE0F}',
                },
                {
                  before: 'Different apps and links',
                  after: 'One WhatsApp conversation',
                  icon: '\u{1F4AC}',
                },
              ].map((item) => (
                <div
                  key={item.after}
                  className="rounded-2xl border border-gray-100 bg-white p-6 text-center"
                >
                  <span className="text-2xl">{item.icon}</span>
                  <p className="mt-3 text-sm text-gray-400 line-through">{item.before}</p>
                  <p className="mt-1 text-sm font-semibold text-gray-900">{item.after}</p>
                </div>
              ))}
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 3. Try Waaiio (WhatsApp Demo) ── */}
      <section className="bg-gradient-to-b from-white to-gray-50/80 py-24">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">See it in action</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">
              Try the WhatsApp experience
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-gray-500">
              Watch how customers book, order, and buy tickets &mdash; all through a WhatsApp conversation.
            </p>
          </AnimatedSection>
          <AnimatedSection className="mt-12">
            <Suspense fallback={<div className="mx-auto h-[400px] max-w-md animate-pulse rounded-2xl bg-gray-100" />}>
              <LiveBotDemo />
            </Suspense>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 4. Ace Section ── */}
      <section className="bg-white py-24">
        <div className="mx-auto max-w-5xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Setup assistant</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">
              Meet Ace &mdash; your AI setup assistant
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-gray-500">
              You describe it. Ace organizes it. Waaiio gets it ready.
            </p>
          </AnimatedSection>

          <AnimatedSection className="mt-12">
            <div className="mx-auto max-w-lg">
              {/* Chat-style example */}
              <div className="space-y-3 rounded-2xl border border-gray-100 bg-gray-50 p-6">
                <div className="flex justify-end">
                  <div className="rounded-lg bg-brand-50 px-4 py-2.5 text-sm text-gray-800">
                    I run a nail salon. Manicure is $35, pedicure is $50.
                  </div>
                </div>
                <div className="flex justify-start">
                  <div className="rounded-lg bg-white px-4 py-2.5 text-sm text-gray-800 shadow-sm">
                    Got it! How long does each service take?
                  </div>
                </div>
                <div className="flex justify-end">
                  <div className="rounded-lg bg-brand-50 px-4 py-2.5 text-sm text-gray-800">
                    Manicure is 30 minutes, pedicure is 45.
                  </div>
                </div>
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-green-700 shadow-sm">
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Services ready to review
                  </div>
                </div>
              </div>

              {/* What Ace does */}
              <div className="mt-8 space-y-3">
                {[
                  'Reads your menu, price list, or photo',
                  'Creates services and products automatically',
                  'Sets your business hours',
                  'Configures your WhatsApp greeting',
                  'Review everything before it goes live',
                ].map((item) => (
                  <div key={item} className="flex items-start gap-3">
                    <svg
                      className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-sm text-gray-600">{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 5. Business Dashboard Proof ── */}
      <section className="bg-gray-50/60 py-24">
        <div className="mx-auto max-w-5xl px-4">
          <AnimatedSection className="text-center">
            <h2 className="text-3xl font-bold text-gray-900 sm:text-4xl">
              WhatsApp for your customers.
              <br />
              <span className="text-brand">One dashboard for you.</span>
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-gray-500">
              Every booking, order, payment, and conversation &mdash; organized in one place. You manage your business while WhatsApp handles the customer experience.
            </p>
          </AnimatedSection>

          <AnimatedSection className="mt-14">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { icon: '\u{1F4C5}', label: 'Bookings', desc: 'Calendar with slots, reminders, and confirmations' },
                { icon: '\u{1F6D2}', label: 'Orders', desc: 'Product catalog, cart, and delivery tracking' },
                { icon: '\u{1F4B3}', label: 'Payments', desc: 'Secure links, receipts, and reconciliation' },
                { icon: '\u{1F3AB}', label: 'Tickets', desc: 'Event sales with QR codes and check-in' },
                { icon: '\u{1F465}', label: 'Customers', desc: 'History, preferences, and repeat behavior' },
                { icon: '\u{1F4CA}', label: 'Analytics', desc: 'Revenue, bookings, and customer insights' },
              ].map((item) => (
                <div key={item.label} className="rounded-2xl border border-gray-100 bg-white p-6 text-center">
                  <span className="text-3xl">{item.icon}</span>
                  <h3 className="mt-3 text-sm font-semibold text-gray-900">{item.label}</h3>
                  <p className="mt-1 text-xs text-gray-500">{item.desc}</p>
                </div>
              ))}
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 6. Compact Capability Summary ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-4xl px-4 text-center">
          <AnimatedSection>
            <h2 className="text-2xl font-bold text-gray-900 sm:text-3xl">
              Everything your business needs on WhatsApp
            </h2>
          </AnimatedSection>

          <AnimatedSection className="mt-12">
            <div className="flex flex-wrap justify-center gap-6 sm:gap-10">
              {[
                { icon: '\u{1F4C5}', label: 'Book' },
                { icon: '\u{1F6D2}', label: 'Order' },
                { icon: '\u{1F4B3}', label: 'Pay' },
                { icon: '\u{1F3AB}', label: 'Sell Tickets' },
                { icon: '\u{1F504}', label: 'Follow Up' },
              ].map((cap) => (
                <div key={cap.label} className="flex flex-col items-center gap-2">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-50 shadow-sm border border-gray-100">
                    <span className="text-2xl">{cap.icon}</span>
                  </div>
                  <span className="text-sm font-medium text-gray-700">{cap.label}</span>
                </div>
              ))}
            </div>
          </AnimatedSection>

          <AnimatedSection className="mt-10">
            <Link
              href="/features"
              className="text-sm font-semibold text-brand transition hover:text-brand-400"
            >
              See all features &rarr;
            </Link>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 7. How It Works ── */}
      <section className="bg-gray-50/60 py-24">
        <div className="mx-auto max-w-5xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Simple setup</p>
            <h2 className="mt-3 text-2xl font-bold text-gray-900 sm:text-3xl">
              Up and running in minutes
            </h2>
          </AnimatedSection>

          <div className="mt-14 grid gap-8 lg:grid-cols-3">
            {[
              {
                step: '1',
                title: 'Tell us what you do',
                desc: 'Add your services, prices, and hours. We configure the bot for your industry.',
              },
              {
                step: '2',
                title: 'Connect WhatsApp',
                desc: 'Use your own number or start with a shared Waaiio number. Once connected, your bot is ready to receive messages.',
              },
              {
                step: '3',
                title: 'Customers start messaging',
                desc: 'They type naturally and the bot handles bookings, orders, and payments.',
              },
            ].map((s, i) => (
              <AnimatedSection key={s.step} delay={i * 0.1}>
                <div className="relative rounded-2xl border border-gray-100 bg-white p-8 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-sm font-bold text-brand">
                    {s.step}
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-gray-900">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-500">{s.desc}</p>
                </div>
              </AnimatedSection>
            ))}
          </div>
        </div>
      </section>

      {/* ── 8. Trust Strip ── */}
      <section className="border-y border-gray-100 bg-gray-50/50 py-10">
        <div className="mx-auto max-w-5xl px-4">
          <div className="flex flex-col items-center gap-8 sm:flex-row sm:justify-center sm:gap-12">
            <div className="flex items-center gap-2.5">
              <svg aria-hidden="true" className="h-5 w-5 text-whatsapp" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
              </svg>
              <span className="text-sm font-medium text-gray-600">Built on WhatsApp Business Platform</span>
            </div>
            <img
              src="/meta-business-partner.svg"
              alt="Meta Business Partner"
              className="h-8 w-auto"
              data-testid="meta-partner-badge"
            />
            <div className="flex items-center gap-6">
              <span className="text-sm font-semibold text-gray-400">Payments by</span>
              <span className="text-sm font-bold text-[#635BFF]">Stripe</span>
              <span className="text-sm font-bold text-[#00C3F7]">Paystack</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── 9. Pricing Preview ── */}
      <section id="pricing" className="bg-white py-24">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Pricing</p>
            <h2 className="mt-3 text-2xl font-bold text-gray-900 sm:text-3xl">
              Simple, transparent pricing
            </h2>
            <p className="mt-2 text-gray-500">
              Start free. Upgrade when you&apos;re ready.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {PRICE_COUNTRIES.map((c) => (
                <button
                  key={c.code}
                  onClick={() => setPriceCountry(c.code)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                    priceCountry === c.code
                      ? 'bg-brand text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {c.flag} {c.label}
                </button>
              ))}
            </div>
          </AnimatedSection>

          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            <AnimatedSection delay={0}>
              <PlanCard
                name={tiers.free.name}
                price={formatCurrency(0, priceCountry)}
                period=""
                features={tiers.free.features}
                cta={{ label: 'Learn More', href: '/pricing' }}
              />
            </AnimatedSection>
            <AnimatedSection delay={0.1}>
              <PlanCard
                name={tiers.growth.name}
                price={formatCurrency(tiers.growth.price as number, priceCountry)}
                period="/month"
                highlight
                features={tiers.growth.features}
                cta={{ label: 'Learn More', href: '/pricing', gold: true }}
              />
            </AnimatedSection>
            <AnimatedSection delay={0.2}>
              <PlanCard
                name={tiers.business.name}
                price={formatCurrency(tiers.business.price as number, priceCountry)}
                period="/month"
                features={tiers.business.features}
                cta={{ label: 'Learn More', href: '/pricing' }}
              />
            </AnimatedSection>
          </div>

          <AnimatedSection delay={0.3} className="mt-8 text-center">
            <Link
              href="/pricing"
              className="text-sm font-semibold text-brand transition hover:text-brand-400"
            >
              See full pricing details &rarr;
            </Link>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 10. FAQ ── */}
      <section id="faq" className="bg-gray-50/60 py-24">
        <div className="mx-auto max-w-3xl px-4">
          <AnimatedSection className="text-center">
            <h2 className="text-2xl font-bold text-gray-900 sm:text-3xl">Frequently Asked Questions</h2>
          </AnimatedSection>
          <div className="mt-10">
            {faqData.map((item) => (
              <FaqItem key={item.question} question={item.question} answer={item.answer} />
            ))}
          </div>
        </div>
      </section>

      {/* ── 11. Final CTA ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-4xl px-4">
          <AnimatedSection>
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-900 via-brand to-brand-700 p-12 text-center lg:p-16">
              <div className="pointer-events-none absolute inset-0 opacity-30">
                <div className="absolute left-1/4 top-1/4 h-64 w-64 rounded-full bg-accent/20 blur-3xl" />
                <div className="absolute bottom-1/4 right-1/4 h-48 w-48 rounded-full bg-brand-300/20 blur-3xl" />
              </div>
              <div className="relative z-10">
                <h2 className="text-3xl font-bold text-white lg:text-4xl">
                  Ready to run your business on WhatsApp?
                </h2>
                <p className="mx-auto mt-4 max-w-lg text-brand-200">
                  Get notified when Waaiio launches and be among the first to automate your business.
                </p>
                <div className="mt-8 flex flex-wrap justify-center gap-3">
                  <Link
                    href="/launch"
                    className="rounded-xl bg-accent px-8 py-4 text-sm font-bold text-gray-900 shadow-lg shadow-accent/25 transition hover:bg-accent-400"
                  >
                    Get Launch Updates
                  </Link>
                  <Link
                    href="/pricing"
                    className="rounded-xl border border-white/30 px-8 py-4 text-sm font-semibold text-white transition hover:bg-white/10"
                  >
                    View Pricing
                  </Link>
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

function PlanCard({
  name,
  price,
  period,
  features,
  highlight,
  cta,
}: {
  name: string;
  price: string;
  period: string;
  features: string[];
  highlight?: boolean;
  cta: { label: string; href: string; gold?: boolean };
}) {
  return (
    <div
      className={`flex flex-col rounded-2xl border p-6 transition hover:-translate-y-1 motion-reduce:hover:translate-y-0 ${
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
            <svg
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {f}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-6">
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
      </div>
    </div>
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
