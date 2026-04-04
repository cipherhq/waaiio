'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BUSINESS_CATEGORIES, formatCurrency, getPricingTiers } from '@/lib/constants';

const PRICING_TIERS = getPricingTiers('NG');

export default function HomePage() {
  return (
    <>
      {/* ── 1. Hero ── */}
      <section className="relative overflow-hidden bg-brand py-20">
        <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-brand-500/20" />
        <div className="pointer-events-none absolute -bottom-20 right-10 h-64 w-64 rounded-full bg-accent/10" />

        <div className="relative mx-auto max-w-5xl px-4 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-sm font-medium text-white backdrop-blur">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
            </span>
            WhatsApp Automation
          </span>

          <h1 className="mt-6 text-balance text-4xl font-bold leading-tight text-white sm:text-5xl">
            WhatsApp Automation for Every Business
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-brand-200">
            Automate bookings, payments, orders, and ticket sales on WhatsApp —
            the app your customers already use. Now available in 5 countries.
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/get-started"
              className="rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-gray-900 transition hover:bg-accent/90"
            >
              Get Started Free
            </Link>
            <Link
              href="#pricing"
              className="rounded-lg border border-white/30 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              View Pricing
            </Link>
          </div>

          <p className="mt-8 text-sm text-brand-200">
            Trusted by 100+ businesses across Nigeria, US, UK, Canada &amp; Ghana
          </p>
        </div>
      </section>

      {/* ── 2. Industry Showcase ── */}
      <section className="bg-white py-16">
        <div className="mx-auto max-w-5xl px-4 text-center">
          <h2 className="text-2xl font-bold text-gray-900">
            Built for Every Industry
          </h2>
          <p className="mt-2 text-gray-600">
            One platform, any business type
          </p>

          <div className="mt-10 grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6">
            {BUSINESS_CATEGORIES.filter(c => c.key !== 'other').map((cat) => (
              <div
                key={cat.key}
                className="flex flex-col items-center gap-2 rounded-xl border border-gray-100 bg-gray-50/50 px-3 py-4"
              >
                <span className="text-2xl">{cat.icon}</span>
                <span className="text-xs font-medium text-gray-700">{cat.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 2b. Global Reach ── */}
      <section className="border-t border-gray-100 bg-white pb-16">
        <div className="mx-auto max-w-5xl px-4 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Available in</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-6">
            {[
              { flag: '\ud83c\uddf3\ud83c\uddec', name: 'Nigeria', gateway: 'Paystack' },
              { flag: '\ud83c\uddfa\ud83c\uddf8', name: 'United States', gateway: 'Stripe' },
              { flag: '\ud83c\uddec\ud83c\udde7', name: 'United Kingdom', gateway: 'Stripe' },
              { flag: '\ud83c\udde8\ud83c\udde6', name: 'Canada', gateway: 'Stripe' },
              { flag: '\ud83c\uddec\ud83c\udded', name: 'Ghana', gateway: 'Paystack' },
            ].map((c) => (
              <div key={c.name} className="flex items-center gap-2 rounded-full border border-gray-100 bg-gray-50 px-4 py-2">
                <span className="text-xl">{c.flag}</span>
                <span className="text-sm font-medium text-gray-700">{c.name}</span>
                <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">{c.gateway}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 3. WhatsApp Conversation Demo ── */}
      <section className="bg-gray-50 py-20">
        <div className="mx-auto max-w-5xl px-4">
          <h2 className="text-center text-2xl font-bold text-gray-900">
            See It in Action
          </h2>
          <p className="mt-2 text-center text-gray-600">
            A typical interaction takes under 60 seconds
          </p>

          <div className="mt-12 grid items-start gap-10 lg:grid-cols-2">
            {/* Chat mockup */}
            <div className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl shadow-xl">
              <div className="flex items-center gap-3 px-4 py-3" style={{ backgroundColor: '#075E54' }}>
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-sm font-bold text-white">
                  BW
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">SmrtRply</p>
                  <p className="text-xs text-green-200">online</p>
                </div>
              </div>

              <div className="space-y-3 p-4" style={{ backgroundColor: '#ECE5DD' }}>
                <ChatBubble from="bot">
                  Welcome to King&apos;s Cuts! {'\ud83d\udc88'} I can help you book an appointment.{'\n\n'}
                  What service would you like?{'\n'}
                  1. Haircut{'\n'}
                  2. Beard Trim{'\n'}
                  3. Full Grooming
                </ChatBubble>
                <ChatBubble from="user">1</ChatBubble>
                <ChatBubble from="bot">
                  Great choice! When would you like to come in?{'\n'}
                  Pick a date:
                </ChatBubble>
                <ChatBubble from="user">Tomorrow</ChatBubble>
                <ChatBubble from="bot">
                  {'\u2705'} Appointment confirmed!{'\n\n'}
                  {'\ud83d\udc88'} Haircut{'\n'}
                  {'\ud83d\udcc5'} Tomorrow, 2:00 PM{'\n'}
                  {'\ud83d\udccd'} King&apos;s Cuts — Victoria Island{'\n'}
                  {'\ud83d\udd16'} Ref: BW-7291{'\n\n'}
                  See you there!
                </ChatBubble>
              </div>
            </div>

            {/* Steps */}
            <div className="space-y-8">
              <StepCallout
                number={1}
                title="Customer sends a message"
                description="When someone messages your WhatsApp, they're greeted with your brand and shown what you offer."
              />
              <StepCallout
                number={2}
                title="Details collected automatically"
                description="Service, date, time, quantity — all collected via a friendly chat. No forms, no links, no app downloads."
              />
              <StepCallout
                number={3}
                title="Instant confirmation + payment"
                description="Booking confirmed in seconds with a reference code. Deposits collected automatically via Paystack."
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── 4. Feature Grid ── */}
      <section id="features" className="bg-white py-20">
        <div className="mx-auto max-w-5xl px-4">
          <h2 className="text-center text-2xl font-bold text-gray-900">
            Everything You Need to Run Your Business on WhatsApp
          </h2>
          <p className="mt-2 text-center text-gray-600">
            Powerful features designed for businesses worldwide
          </p>

          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              color="bg-green-100 text-green-700"
              icon={
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              }
              title="24/7 WhatsApp Automation"
              description="Accept bookings, payments, and orders any time — even when your staff are busy or you're closed."
            />
            <FeatureCard
              color="bg-blue-100 text-blue-700"
              icon={
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              }
              title="Multi-Industry Support"
              description="Restaurants, barbers, churches, shops, events — one platform handles scheduling, payments, orders, and tickets."
            />
            <FeatureCard
              color="bg-purple-100 text-purple-700"
              icon={
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
              }
              title="Business Dashboard"
              description="View, manage, and export all bookings, orders, and payments from a clean web dashboard."
            />
            <FeatureCard
              color="bg-amber-100 text-amber-700"
              icon={
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              }
              title="Paystack Payments"
              description="Collect deposits, fees, and payments via Paystack or Stripe — automatically prompted during the chat."
            />
            <FeatureCard
              color="bg-red-100 text-red-700"
              icon={
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              }
              title="Automatic Reminders"
              description="Reminders go out before appointments and events, cutting no-shows dramatically."
            />
            <FeatureCard
              color="bg-brand-100 text-brand-700"
              icon={
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              }
              title="Custom Persona"
              description="Personalize with your business name and personality. Customers interact with your brand, not ours."
            />
          </div>
        </div>
      </section>

      {/* ── 5. Four Flow Types ── */}
      <section className="bg-gray-50 py-20">
        <div className="mx-auto max-w-5xl px-4">
          <h2 className="text-center text-2xl font-bold text-gray-900">
            Four Flows, Every Business
          </h2>
          <p className="mt-2 text-center text-gray-600">
            We auto-configure the right flow for your industry
          </p>

          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            <FlowCard
              emoji="📅"
              title="Scheduling"
              description="Appointments and reservations with date, time, and service selection."
              industries="Restaurants, Barbers, Spas, Salons, Gyms, Clinics"
            />
            <FlowCard
              emoji="💳"
              title="Payments"
              description="Category-based payments with custom amounts. Perfect for tithes, fees, and donations."
              industries="Churches, Mosques, Schools, NGOs"
            />
            <FlowCard
              emoji="🛒"
              title="Ordering"
              description="Product catalog, cart management, delivery or pickup, and checkout."
              industries="Shops, Retail, Food Delivery"
            />
            <FlowCard
              emoji="🎫"
              title="Ticketing"
              description="Event listings, ticket selection, availability checks, and instant purchase."
              industries="Events, Transport, Cinemas"
            />
          </div>
        </div>
      </section>

      {/* ── 6. Stats Bar ── */}
      <section className="bg-brand py-14">
        <div className="mx-auto grid max-w-5xl grid-cols-2 gap-8 px-4 text-center md:grid-cols-4">
          {[
            { value: '100+', label: 'Businesses' },
            { value: '25,000+', label: 'Transactions' },
            { value: '60%', label: 'Fewer No-Shows' },
            { value: '24/7', label: 'Available' },
          ].map((s) => (
            <div key={s.label}>
              <p className="text-3xl font-bold text-white">{s.value}</p>
              <p className="mt-1 text-sm text-brand-200">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── 7. Testimonials ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-5xl px-4">
          <h2 className="text-center text-2xl font-bold text-gray-900">
            What Business Owners Say
          </h2>
          <p className="mt-2 text-center text-gray-600">
            Real results from real businesses
          </p>

          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            <TestimonialCard
              quote="We went from missing 40% of after-hours booking requests to capturing every single one. Revenue is up 30% in 3 months."
              name="Adebayo O."
              role="King's Cuts Barbershop, Lagos"
              stat="30% more revenue"
            />
            <TestimonialCard
              quote="Our members can now pay tithes and offerings directly on WhatsApp. Collections are up and our admin team saves hours every week."
              name="Pastor Grace A."
              role="New Life Church, Abuja"
              stat="5hrs saved weekly"
            />
            <TestimonialCard
              quote="Customers love ordering via WhatsApp instead of calling. Our average order value went up because the bot upsells naturally."
              name="Chioma N."
              role="Fresh Bites Delivery, Port Harcourt"
              stat="22% higher AOV"
            />
          </div>
        </div>
      </section>

      {/* ── 8. Pricing ── */}
      <section id="pricing" className="bg-white py-20">
        <div className="mx-auto max-w-5xl px-4">
          <h2 className="text-center text-2xl font-bold text-gray-900">
            Simple, Transparent Pricing
          </h2>
          <p className="mt-2 text-center text-gray-600">
            Start free. Upgrade when you&apos;re ready.
          </p>

          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            <PlanCard
              name={PRICING_TIERS.free.name}
              price={formatCurrency(0, 'NG')}
              period=""
              features={PRICING_TIERS.free.features}
              cta={{ label: 'Start Free', href: '/get-started' }}
            />

            <PlanCard
              name={PRICING_TIERS.growth.name}
              price={formatCurrency(PRICING_TIERS.growth.price as number, 'NG')}
              period="/month"
              highlight
              features={PRICING_TIERS.growth.features}
              cta={{ label: 'Get Started', href: '/get-started?plan=growth', gold: true }}
            />

            <PlanCard
              name={PRICING_TIERS.business.name}
              price={formatCurrency(PRICING_TIERS.business.price as number, 'NG')}
              period="/month"
              features={PRICING_TIERS.business.features}
              cta={{ label: 'Get Started', href: '/get-started?plan=business' }}
            />
          </div>
        </div>
      </section>

      {/* ── 8. How to Get Started ── */}
      <section className="bg-gray-50 py-20">
        <div className="mx-auto max-w-3xl px-4 text-center">
          <h2 className="text-2xl font-bold text-gray-900">
            Get Started in 3 Simple Steps
          </h2>
          <div className="mt-12 grid gap-8 sm:grid-cols-3">
            {[
              {
                step: '1',
                title: 'Sign Up & Pick Your Category',
                description: 'Create your account and tell us what kind of business you run.',
              },
              {
                step: '2',
                title: 'Customize Your Bot',
                description: 'Set your greeting, services, and persona. We connect WhatsApp automatically.',
              },
              {
                step: '3',
                title: 'Share Your Link',
                description: 'Share your WhatsApp link with customers and the automation handles the rest.',
              },
            ].map((s) => (
              <div key={s.step}>
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
                  {s.step}
                </span>
                <h3 className="mt-3 text-sm font-semibold text-gray-900">{s.title}</h3>
                <p className="mt-1 text-sm text-gray-600">{s.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 9. FAQ ── */}
      <section id="faq" className="bg-white py-20">
        <div className="mx-auto max-w-5xl px-4">
          <h2 className="text-center text-2xl font-bold text-gray-900">
            Frequently Asked Questions
          </h2>
          <div className="mx-auto mt-10 max-w-2xl space-y-6">
            <FaqItem
              question="What types of businesses can use SmrtRply?"
              answer="Any business that wants WhatsApp automation — restaurants, barbers, spas, churches, schools, shops, event companies, and more. We support scheduling, payments, ordering, and ticketing flows."
            />
            <FaqItem
              question="Is there really a free plan?"
              answer="Yes! Start with our Free plan — 7-day trial with zero fees, then a small per-transaction fee. No monthly subscription required."
            />
            <FaqItem
              question="How do payments work?"
              answer="When a customer needs to pay (deposit, fee, order, ticket), they receive a secure payment link in the chat via Paystack (Nigeria, Ghana) or Stripe (US, UK, Canada). Funds go directly to your account."
            />
            <FaqItem
              question="Can I customise the messages?"
              answer="Yes. You can set a custom assistant name, greeting, and personality that matches your brand."
            />
            <FaqItem
              question="What happens outside operating hours?"
              answer="The automation works 24/7 — it will take bookings and orders even at 2 AM. You can set operating hours so only available time slots are offered."
            />
            <FaqItem
              question="Is there a long-term contract?"
              answer="No. All plans are month-to-month with no lock-in. You can upgrade, downgrade, or cancel at any time."
            />
          </div>
        </div>
      </section>

      {/* ── 10. Final CTA ── */}
      <section className="bg-gray-50 py-20">
        <div className="mx-auto max-w-5xl px-4">
          <div className="rounded-2xl bg-brand p-10 text-center">
            <h2 className="text-2xl font-bold text-white">
              Ready to Automate Your Business on WhatsApp?
            </h2>
            <p className="mt-2 text-brand-200">
              Join 100+ businesses already saving time and growing revenue
              with SmrtRply&apos;s WhatsApp Automation.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link
                href="/get-started"
                className="rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-gray-900 transition hover:bg-accent/90"
              >
                Get Started Free
              </Link>
              <Link
                href="/contact"
                className="rounded-lg border border-white/30 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                Talk to Sales
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/* ─── Local Helper Components ─── */

function ChatBubble({
  from,
  children,
}: {
  from: 'bot' | 'user';
  children: React.ReactNode;
}) {
  const isBot = from === 'bot';
  return (
    <div className={`flex ${isBot ? 'justify-start' : 'justify-end'}`}>
      <div
        className={`max-w-[85%] whitespace-pre-line rounded-lg px-3 py-2 text-sm ${
          isBot ? 'bg-white text-gray-800' : 'text-white'
        }`}
        style={!isBot ? { backgroundColor: '#DCF8C6', color: '#111' } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

function StepCallout({
  number,
  title,
  description,
}: {
  number: number;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-4">
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
        {number}
      </span>
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <p className="mt-1 text-sm text-gray-600">{description}</p>
      </div>
    </div>
  );
}

function FeatureCard({
  color,
  icon,
  title,
  description,
}: {
  color: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-6">
      <div className={`inline-flex h-10 w-10 items-center justify-center rounded-lg ${color}`}>
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {icon}
        </svg>
      </div>
      <h3 className="mt-4 text-sm font-semibold text-gray-900">{title}</h3>
      <p className="mt-1 text-sm text-gray-600">{description}</p>
    </div>
  );
}

function FlowCard({
  emoji,
  title,
  description,
  industries,
}: {
  emoji: string;
  title: string;
  description: string;
  industries: string;
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-6">
      <div className="flex items-center gap-3">
        <span className="text-2xl">{emoji}</span>
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      </div>
      <p className="mt-2 text-sm text-gray-600">{description}</p>
      <p className="mt-3 text-xs text-gray-400">{industries}</p>
    </div>
  );
}

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
      className={`flex flex-col rounded-xl border p-6 ${
        highlight
          ? 'border-brand bg-brand-50/30 ring-1 ring-brand'
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
      <div className="mt-6 pt-2">
        <Link
          href={cta.href}
          className={`block rounded-lg px-4 py-2.5 text-center text-sm font-semibold transition ${
            cta.gold
              ? 'bg-accent text-gray-900 hover:bg-accent/90'
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

function TestimonialCard({
  quote,
  name,
  role,
  stat,
}: {
  quote: string;
  name: string;
  role: string;
  stat: string;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-gray-100 bg-gray-50/50 p-6">
      <div className="mb-4 inline-flex self-start rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand">
        {stat}
      </div>
      <p className="flex-1 text-sm text-gray-700 leading-relaxed">&ldquo;{quote}&rdquo;</p>
      <div className="mt-4 flex items-center gap-3 border-t border-gray-100 pt-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">
          {name.charAt(0)}
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-900">{name}</p>
          <p className="text-xs text-gray-500">{role}</p>
        </div>
      </div>
    </div>
  );
}

function FaqItem({ question, answer }: { question: string; answer: string }) {
  'use client';
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-100 pb-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-left"
      >
        <h3 className="text-sm font-semibold text-gray-900">{question}</h3>
        <svg
          className={`h-4 w-4 shrink-0 text-gray-400 transition ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <p className="mt-2 text-sm text-gray-600">{answer}</p>}
    </div>
  );
}
