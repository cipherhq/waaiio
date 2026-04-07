'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { BUSINESS_CATEGORIES, formatCurrency, getPricingTiers } from '@/lib/constants';

const PRICING_TIERS = getPricingTiers('NG');
const CATEGORY_COUNT = BUSINESS_CATEGORIES.filter(c => c.key !== 'other').length;

export default function HomePage() {
  return (
    <>
      {/* ── 1. Hero ── */}
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 lg:py-28">
        {/* Decorative blobs */}
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />

        <div className="relative mx-auto max-w-6xl px-4">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            {/* Left: Copy */}
            <div className="text-center lg:text-left">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-sm font-medium text-white backdrop-blur">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
                </span>
                WhatsApp Automation Platform
              </span>

              <h1 className="mt-6 text-balance text-4xl font-extrabold leading-tight text-white sm:text-5xl lg:text-[3.5rem]">
                Automate Any Business with{' '}
                <span className="text-accent">AI-Powered</span> WhatsApp
              </h1>
              <p className="mx-auto mt-5 max-w-lg text-lg leading-relaxed text-brand-200 lg:mx-0">
                Bookings, payments, orders, donations, ticketing, and more — for {CATEGORY_COUNT}+ industries
                including churches, salons, restaurants, clinics, and shops. Available in 5 countries.
              </p>

              <div className="mt-8 flex flex-wrap justify-center gap-3 lg:justify-start">
                <Link
                  href="/get-started"
                  className="rounded-xl bg-accent px-7 py-3.5 text-sm font-bold text-gray-900 shadow-lg shadow-accent/25 transition hover:bg-accent-400 hover:shadow-accent/40"
                >
                  Get Started Free
                </Link>
                <Link
                  href="/pricing"
                  className="rounded-xl border border-white/30 px-7 py-3.5 text-sm font-semibold text-white transition hover:bg-white/10"
                >
                  View Pricing
                </Link>
              </div>

              {/* Social proof mini */}
              <div className="mt-8 flex items-center justify-center gap-4 lg:justify-start">
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
              </div>
            </div>

            {/* Right: Rotating chat mockup */}
            <HeroChatMockup />
          </div>
        </div>
      </section>

      {/* ── Social Proof Bar ── */}
      <section className="border-b border-gray-100 bg-white py-8">
        <div className="mx-auto max-w-6xl px-4">
          <p className="text-center text-xs font-semibold uppercase tracking-widest text-gray-400">
            Empowering businesses across 5 countries
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {[
              { flag: '\ud83c\uddf3\ud83c\uddec', name: 'Nigeria', gateway: 'Paystack' },
              { flag: '\ud83c\uddfa\ud83c\uddf8', name: 'United States', gateway: 'Stripe' },
              { flag: '\ud83c\uddec\ud83c\udde7', name: 'United Kingdom', gateway: 'Stripe' },
              { flag: '\ud83c\udde8\ud83c\udde6', name: 'Canada', gateway: 'Stripe' },
              { flag: '\ud83c\uddec\ud83c\udded', name: 'Ghana', gateway: 'Paystack' },
            ].map((c) => (
              <div key={c.name} className="flex items-center gap-2">
                <span className="text-xl">{c.flag}</span>
                <span className="text-sm font-medium text-gray-700">{c.name}</span>
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">{c.gateway}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How Waaiio Empowers You ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4 text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-brand">How Waaiio empowers you</p>
          <h2 className="mt-3 text-3xl font-bold text-gray-900">
            Everything your business needs on WhatsApp
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-gray-600">
            Run bookings, accept payments, take orders, and sell tickets — all from the app 2 billion people already use.
          </p>

          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { icon: '&#x1F4C5;', title: '24/7 WhatsApp Automation', desc: 'Accept bookings, payments, and orders any time — even when your staff are busy or you\'re closed.' },
              { icon: '&#x1F3ED;', title: 'Multi-Industry Support', desc: `Churches, salons, clinics, shops, schools, NGOs, events, and more — ${CATEGORY_COUNT}+ business categories supported out of the box.` },
              { icon: '&#x1F4CA;', title: 'Real-Time Dashboard', desc: 'View, manage, and export all bookings, orders, and payments from a clean analytics dashboard.' },
              { icon: '&#x1F4B3;', title: 'Integrated Payments', desc: 'Collect payments, tithes, donations, and fees via Paystack (NG, GH) or Stripe (US, UK, CA) — prompted automatically in chat.' },
              { icon: '&#x1F514;', title: 'Smart Reminders', desc: 'Automatic reminders before appointments and events, cutting no-shows by up to 60%.' },
              { icon: '&#x2728;', title: 'Custom Brand Persona', desc: 'Your business name, personality, and greeting. Customers interact with your brand, not ours.' },
            ].map((f) => (
              <div key={f.title} className="group rounded-2xl border border-gray-100 bg-white p-6 text-left transition hover:border-brand-200 hover:shadow-lg hover:shadow-brand-50">
                <span className="text-3xl" dangerouslySetInnerHTML={{ __html: f.icon }} />
                <h3 className="mt-4 text-base font-semibold text-gray-900">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-gray-600">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── WHY WAAIIO — 3 Big Cards ── */}
      <section className="bg-gray-50 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <p className="text-center text-xs font-bold uppercase tracking-widest text-brand">Why Waaiio?</p>
          <h2 className="mt-3 text-center text-3xl font-bold text-gray-900">
            Three powerful reasons to switch
          </h2>

          <div className="mt-14 grid gap-8 lg:grid-cols-3">
            <WhyCard
              number="01"
              title="Lead Generation"
              desc="Every WhatsApp message becomes a potential sale. Your bot qualifies leads, captures contact info, and converts casual browsers into paying customers — automatically."
              color="brand"
            />
            <WhyCard
              number="02"
              title="Customizable Flows"
              desc="Choose from 4 pre-built flows — scheduling, payments, ordering, and ticketing — that auto-configure for your industry. Customize greetings, services, and persona."
              color="accent"
            />
            <WhyCard
              number="03"
              title="AI-Powered Commerce"
              desc="Smart intent detection understands what customers want. The bot handles upsells, collects payments, sends confirmations, and learns from every interaction."
              color="whatsapp"
            />
          </div>
        </div>
      </section>

      {/* ── Industry Showcase ── */}
      <section className="bg-gray-950 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <div className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand-300">Built for every industry</p>
            <h2 className="mt-3 text-3xl font-bold text-white">
              One platform, {CATEGORY_COUNT}+ business types
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-gray-400">
              Four automation flows, each tailored for different industries. Pick your category and we auto-configure the right experience.
            </p>
          </div>

          <div className="mt-14 space-y-8">
            {([
              { flow: 'scheduling' as const, label: 'Scheduling', icon: '\u{1F4C5}', accent: 'blue', description: 'Appointments & reservations' },
              { flow: 'payment' as const, label: 'Payments', icon: '\u{1F4B3}', accent: 'green', description: 'Tithes, fees & donations' },
              { flow: 'ordering' as const, label: 'Ordering', icon: '\u{1F6D2}', accent: 'amber', description: 'Products & delivery' },
              { flow: 'ticketing' as const, label: 'Ticketing', icon: '\u{1F3AB}', accent: 'purple', description: 'Events & transport' },
            ]).map((group) => {
              const cats = BUSINESS_CATEGORIES.filter(c => c.key !== 'other' && c.flow === group.flow);
              const accentMap: Record<string, { border: string; bg: string; dot: string; pill: string; pillHover: string; text: string }> = {
                blue:   { border: 'border-blue-500/20', bg: 'bg-blue-500/5', dot: 'bg-blue-400', pill: 'bg-blue-500/10 text-blue-300', pillHover: 'hover:bg-blue-500/20', text: 'text-blue-400' },
                green:  { border: 'border-green-500/20', bg: 'bg-green-500/5', dot: 'bg-green-400', pill: 'bg-green-500/10 text-green-300', pillHover: 'hover:bg-green-500/20', text: 'text-green-400' },
                amber:  { border: 'border-amber-500/20', bg: 'bg-amber-500/5', dot: 'bg-amber-400', pill: 'bg-amber-500/10 text-amber-300', pillHover: 'hover:bg-amber-500/20', text: 'text-amber-400' },
                purple: { border: 'border-purple-500/20', bg: 'bg-purple-500/5', dot: 'bg-purple-400', pill: 'bg-purple-500/10 text-purple-300', pillHover: 'hover:bg-purple-500/20', text: 'text-purple-400' },
              };
              const a = accentMap[group.accent];
              return (
                <div key={group.flow} className={`rounded-2xl border ${a.border} ${a.bg} p-5 sm:p-6`}>
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{group.icon}</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className={`text-sm font-semibold ${a.text}`}>{group.label}</h3>
                        <span className={`h-1.5 w-1.5 rounded-full ${a.dot}`} />
                        <span className="text-xs text-gray-500">{cats.length} industries</span>
                      </div>
                      <p className="text-xs text-gray-500">{group.description}</p>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {cats.map((cat) => (
                      <span
                        key={cat.key}
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${a.pill} ${a.pillHover}`}
                      >
                        <span className="text-sm leading-none">{cat.icon}</span>
                        {cat.label}
                      </span>
                    ))}
                    <span className="inline-flex items-center rounded-full px-3 py-1.5 text-xs font-medium text-gray-600">
                      and more...
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Four Flows ── */}
      <section className="bg-gray-50 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <p className="text-center text-xs font-bold uppercase tracking-widest text-brand">4 automation flows</p>
          <h2 className="mt-3 text-center text-3xl font-bold text-gray-900">
            We auto-configure the right flow for your industry
          </h2>

          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            <FlowCard
              emoji="&#x1F4C5;"
              title="Scheduling"
              description="Appointments and reservations with date, time, and service selection. Automatic reminders reduce no-shows."
              industries="Restaurants, Barbers, Spas, Salons, Gyms, Clinics, Hotels, Car Wash, Tattoo, Dental, Vet, Laundry, Tutors, Photographers, Real Estate, Travel, Coworking"
              color="border-blue-200 bg-blue-50/50"
            />
            <FlowCard
              emoji="&#x1F4B3;"
              title="Payments"
              description="Category-based payments with custom amounts. Perfect for tithes, offerings, donations, fees, and dues."
              industries="Churches, Mosques, Schools, NGOs, Government, Crowdfunding, Parking, Taxi, Funeral Services"
              color="border-green-200 bg-green-50/50"
            />
            <FlowCard
              emoji="&#x1F6D2;"
              title="Ordering"
              description="Product catalog, cart management, delivery or pickup, and checkout with inventory tracking."
              industries="Shops, Food Delivery, Online Vendors, Pharmacies, Mall Vendors, Logistics, Catering, Tailors"
              color="border-amber-200 bg-amber-50/50"
            />
            <FlowCard
              emoji="&#x1F3AB;"
              title="Ticketing"
              description="Event listings, ticket selection, availability checks, and instant purchase."
              industries="Events, Transport, Cinemas"
              color="border-purple-200 bg-purple-50/50"
            />
          </div>
        </div>
      </section>

      {/* ── Intelligent AI Section ── */}
      <section className="bg-brand py-20">
        <div className="mx-auto max-w-6xl px-4">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-brand-200">Intelligent AI</p>
              <h2 className="mt-3 text-3xl font-bold text-white">
                AI that understands your customers
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-brand-200">
                Waaiio uses advanced intent detection to understand what customers want — even from casual, misspelled, or slang-filled messages.
              </p>

              <div className="mt-8 space-y-4">
                {[
                  { title: 'Smart Intent Detection', desc: 'Detects booking requests, complaints, questions, and payment intents from natural language.' },
                  { title: 'Auto-Upsell & Cross-sell', desc: 'Suggests complementary services and premium options during the conversation flow.' },
                  { title: 'Multi-Language Support', desc: 'Understands Pidgin, Yoruba greetings, and mixed-language messages common in African markets.' },
                  { title: 'Profanity & Spam Filter', desc: 'Built-in moderation keeps conversations clean and professional for your brand.' },
                ].map((item) => (
                  <div key={item.title} className="flex gap-3">
                    <div className="mt-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-accent">
                      <svg className="h-3 w-3 text-gray-900" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-white">{item.title}</p>
                      <p className="mt-0.5 text-sm text-brand-200">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* AI visual */}
            <div className="mx-auto max-w-sm">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                <div className="space-y-3">
                  <div className="rounded-lg bg-white/10 p-3">
                    <p className="text-xs text-brand-200">Customer says:</p>
                    <p className="mt-1 text-sm font-medium text-white">&quot;abeg I wan cut hair tomorrow for morning&quot;</p>
                  </div>
                  <div className="flex items-center gap-2 text-accent">
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    <span className="text-xs font-bold">AI Processing</span>
                  </div>
                  <div className="rounded-lg bg-white/10 p-3">
                    <p className="text-xs text-brand-200">Detected intent:</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <span className="rounded-full bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">booking</span>
                      <span className="rounded-full bg-green-400/20 px-2 py-0.5 text-xs font-medium text-green-300">haircut</span>
                      <span className="rounded-full bg-blue-400/20 px-2 py-0.5 text-xs font-medium text-blue-300">tomorrow AM</span>
                    </div>
                  </div>
                  <div className="rounded-lg bg-whatsapp/20 p-3">
                    <p className="text-xs text-brand-200">Bot responds:</p>
                    <p className="mt-1 text-sm text-white">
                      &#x2705; I&apos;ve got you! I have these morning slots for tomorrow:{'\n'}
                      1. 8:00 AM{'\n'}
                      2. 9:00 AM{'\n'}
                      3. 10:00 AM{'\n'}
                      Which one works for you?
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats Bar ── */}
      <section className="bg-gray-900 py-14">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-4 text-center md:grid-cols-4">
          {[
            { value: '100+', label: 'Businesses Served' },
            { value: '25,000+', label: 'Transactions Processed' },
            { value: '60%', label: 'Fewer No-Shows' },
            { value: '24/7', label: 'Always Available' },
          ].map((s) => (
            <div key={s.label}>
              <p className="text-3xl font-extrabold text-white">{s.value}</p>
              <p className="mt-1 text-sm text-gray-400">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Testimonials ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <p className="text-center text-xs font-bold uppercase tracking-widest text-brand">Customer Feedback</p>
          <h2 className="mt-3 text-center text-3xl font-bold text-gray-900">
            What business owners say
          </h2>
          <p className="mt-2 text-center text-gray-600">
            Real results from real businesses
          </p>

          {/* Horizontal scroll on mobile, grid on desktop */}
          <div className="mt-12 flex gap-6 overflow-x-auto pb-4 lg:grid lg:grid-cols-3 lg:overflow-visible lg:pb-0">
            <TestimonialCard
              quote="Our members can now pay tithes, offerings, and seed directly on WhatsApp. Collections are up and our admin team saves hours every week."
              name="Pastor Grace A."
              role="New Life Church, Abuja"
              stat="5hrs saved weekly"
              metric="-5hrs"
            />
            <TestimonialCard
              quote="We went from missing 40% of after-hours booking requests to capturing every single one. Revenue is up 30% in 3 months."
              name="Adebayo O."
              role="King's Cuts Barbershop, Lagos"
              stat="30% more revenue"
              metric="+30%"
            />
            <TestimonialCard
              quote="Customers love ordering via WhatsApp instead of calling. Our average order value went up because the bot upsells naturally."
              name="Chioma N."
              role="Fresh Bites Delivery, PH"
              stat="22% higher AOV"
              metric="+22%"
            />
          </div>

          {/* Second row of testimonials */}
          <div className="mt-6 flex gap-6 overflow-x-auto pb-4 lg:grid lg:grid-cols-3 lg:overflow-visible lg:pb-0">
            <TestimonialCard
              quote="Zakat and sadaqah donations come in seamlessly now. The bot handles contribution categories and sends instant receipts — very professional."
              name="Imam Yusuf K."
              role="Al-Noor Mosque, London"
              stat="40% more donations"
              metric="+40%"
            />
            <TestimonialCard
              quote="Parents can now check balances and pay school fees on WhatsApp. Our accounts department processes 3x more payments with zero manual entry."
              name="Mrs. Okonkwo"
              role="Prestige Academy, Abuja"
              stat="3x faster processing"
              metric="3x"
            />
            <TestimonialCard
              quote="We sell event tickets through WhatsApp now. Attendees get instant QR codes and we have real-time visibility on every sale."
              name="Tunde A."
              role="Lagos Event Co."
              stat="2x ticket sales"
              metric="2x"
            />
          </div>
        </div>
      </section>

      {/* ── Pricing Preview ── */}
      <section id="pricing" className="bg-gray-50 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <p className="text-center text-xs font-bold uppercase tracking-widest text-brand">Pricing</p>
          <h2 className="mt-3 text-center text-3xl font-bold text-gray-900">
            Simple, transparent pricing
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

          <div className="mt-8 text-center">
            <Link
              href="/pricing"
              className="text-sm font-semibold text-brand hover:text-brand-400 transition"
            >
              See full pricing details with billing calculator &rarr;
            </Link>
          </div>
        </div>
      </section>

      {/* ── Get Started Steps ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-4xl px-4 text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-brand">How it works</p>
          <h2 className="mt-3 text-3xl font-bold text-gray-900">
            Get started in 3 simple steps
          </h2>

          <div className="mt-14 grid gap-8 sm:grid-cols-3">
            {[
              { step: '1', title: 'Sign Up & Pick Your Category', description: `Create your account and tell us what kind of business or organisation you run. We support ${CATEGORY_COUNT}+ categories.`, icon: '&#x1F464;' },
              { step: '2', title: 'Customize Your Bot', description: 'Set your greeting, services, operating hours, and persona. We connect WhatsApp automatically via Gupshup.', icon: '&#x2699;&#xFE0F;' },
              { step: '3', title: 'Go Live & Grow', description: 'Share your WhatsApp link with customers. The bot handles bookings, payments, and orders 24/7.', icon: '&#x1F680;' },
            ].map((s) => (
              <div key={s.step} className="relative">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-2xl">
                  <span dangerouslySetInnerHTML={{ __html: s.icon }} />
                </div>
                <h3 className="mt-4 text-base font-semibold text-gray-900">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-gray-600">{s.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="bg-gray-50 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <p className="text-center text-xs font-bold uppercase tracking-widest text-brand">FAQ</p>
          <h2 className="mt-3 text-center text-3xl font-bold text-gray-900">
            Frequently Asked Questions
          </h2>

          <div className="mx-auto mt-12 grid max-w-4xl gap-x-12 gap-y-0 lg:grid-cols-2">
            <div className="space-y-0">
              <FaqItem
                question="What types of businesses can use Waaiio?"
                answer={`Any business or organisation that wants WhatsApp automation — restaurants, barbers, spas, churches, mosques, schools, NGOs, clinics, shops, event companies, hotels, pharmacies, and much more. We support ${CATEGORY_COUNT}+ categories with 4 automation flows.`}
              />
              <FaqItem
                question="Is there really a free plan?"
                answer="Yes! Start with our Free plan — 7-day trial with zero fees, then a small per-transaction fee. No monthly subscription required."
              />
              <FaqItem
                question="How do payments work?"
                answer="When a customer needs to pay, they receive a secure payment link in the chat via Paystack (Nigeria, Ghana) or Stripe (US, UK, Canada). Funds go directly to your account."
              />
            </div>
            <div className="space-y-0">
              <FaqItem
                question="Can I customise the messages?"
                answer="Yes. You can set a custom assistant name, greeting, and personality that matches your brand. Business-tier users get full white-label."
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
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-brand-900 via-brand to-brand-700 p-12 text-center lg:p-16">
            <h2 className="text-3xl font-bold text-white lg:text-4xl">
              Ready to automate your business on WhatsApp?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-brand-200">
              Join 100+ businesses already saving time and growing revenue
              with Waaiio.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link
                href="/get-started"
                className="rounded-xl bg-accent px-8 py-4 text-sm font-bold text-gray-900 shadow-lg shadow-accent/25 transition hover:bg-accent-400"
              >
                Get Started Free
              </Link>
              <Link
                href="/contact"
                className="rounded-xl border border-white/30 px-8 py-4 text-sm font-semibold text-white transition hover:bg-white/10"
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

function WhyCard({ number, title, desc, color }: { number: string; title: string; desc: string; color: string }) {
  const borderColor = color === 'brand' ? 'border-brand/20 hover:border-brand' : color === 'accent' ? 'border-accent/20 hover:border-accent' : 'border-whatsapp/20 hover:border-whatsapp';
  const numColor = color === 'brand' ? 'text-brand' : color === 'accent' ? 'text-accent' : 'text-whatsapp';
  return (
    <div className={`rounded-2xl border-2 ${borderColor} bg-white p-8 transition`}>
      <span className={`text-4xl font-black ${numColor} opacity-30`}>{number}</span>
      <h3 className="mt-4 text-xl font-bold text-gray-900">{title}</h3>
      <p className="mt-3 text-sm leading-relaxed text-gray-600">{desc}</p>
    </div>
  );
}

function FlowCard({
  emoji,
  title,
  description,
  industries,
  color,
}: {
  emoji: string;
  title: string;
  description: string;
  industries: string;
  color: string;
}) {
  return (
    <div className={`rounded-2xl border ${color} p-6`}>
      <div className="flex items-center gap-3">
        <span className="text-2xl" dangerouslySetInnerHTML={{ __html: emoji }} />
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      </div>
      <p className="mt-2 text-sm text-gray-600">{description}</p>
      <p className="mt-3 text-xs font-medium text-gray-400">{industries}</p>
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
      className={`flex flex-col rounded-2xl border p-6 ${
        highlight
          ? 'border-brand bg-brand-50/30 ring-2 ring-brand shadow-lg shadow-brand-50'
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
      <div className="mt-auto pt-6">
        <Link
          href={cta.href}
          className={`block rounded-xl px-4 py-3 text-center text-sm font-semibold transition ${
            cta.gold
              ? 'bg-accent text-gray-900 hover:bg-accent-400 shadow-lg shadow-accent/20'
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
  metric,
}: {
  quote: string;
  name: string;
  role: string;
  stat: string;
  metric: string;
}) {
  return (
    <div className="flex min-w-[280px] flex-col rounded-2xl border border-gray-100 bg-white p-6 shadow-sm lg:min-w-0">
      <div className="mb-4 flex items-center justify-between">
        <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand">
          {stat}
        </span>
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
    </div>
  );
}

const HERO_DEMOS = [
  {
    name: "King's Cuts",
    avatar: 'K',
    messages: [
      { from: 'bot' as const, text: "Welcome to King's Cuts! \ud83d\udc88 I can help you book an appointment.\n\nWhat service would you like?\n1. Haircut\n2. Beard Trim\n3. Full Grooming" },
      { from: 'user' as const, text: '1' },
      { from: 'bot' as const, text: 'Great choice! When would you like to come in?' },
      { from: 'user' as const, text: 'Tomorrow 2pm' },
      { from: 'bot' as const, text: "\u2705 Appointment confirmed!\n\n\ud83d\udc88 Haircut\n\ud83d\udcc5 Tomorrow, 2:00 PM\n\ud83d\udccd King's Cuts \u2014 VI\n\ud83d\udd16 Ref: BW-7291" },
    ],
  },
  {
    name: 'New Life Church',
    avatar: 'N',
    messages: [
      { from: 'bot' as const, text: "Welcome to New Life Church! \u26ea\n\nHow can I help you today?\n1. Pay Tithe\n2. Give Offering\n3. Seed / Donation\n4. View Upcoming Events" },
      { from: 'user' as const, text: '1' },
      { from: 'bot' as const, text: 'How much would you like to give as tithe?' },
      { from: 'user' as const, text: '50000' },
      { from: 'bot' as const, text: "\u2705 Tithe of \u20a650,000 recorded!\n\n\ud83d\udcb3 Pay here: pay.waaiio.com/t/NLC-4821\n\n\ud83d\ude4f God bless you!" },
    ],
  },
  {
    name: 'Al-Noor Mosque',
    avatar: 'A',
    messages: [
      { from: 'bot' as const, text: "Assalamu Alaikum! Welcome to Al-Noor Mosque \ud83d\udd4c\n\nHow can we assist you?\n1. Pay Zakat\n2. Sadaqah / Donation\n3. Friday Jummah Info\n4. Ramadan Schedule" },
      { from: 'user' as const, text: '1' },
      { from: 'bot' as const, text: 'JazakAllah Khair. How much would you like to give as Zakat?' },
      { from: 'user' as const, text: '\u00a3500' },
      { from: 'bot' as const, text: "\u2705 Zakat of \u00a3500 recorded!\n\n\ud83d\udcb3 Pay here: pay.waaiio.com/z/ANM-1093\n\nMay Allah accept your ibadah \ud83e\udd32" },
    ],
  },
  {
    name: 'Fresh Bites',
    avatar: 'F',
    messages: [
      { from: 'bot' as const, text: "Welcome to Fresh Bites! \ud83c\udf54\n\nWhat would you like to order?\n1. Jollof Rice & Chicken\n2. Pounded Yam & Egusi\n3. Shawarma Platter\n4. View Full Menu" },
      { from: 'user' as const, text: '1' },
      { from: 'bot' as const, text: 'How many portions?' },
      { from: 'user' as const, text: '2' },
      { from: 'bot' as const, text: "\u2705 Order placed!\n\n\ud83c\udf5b 2x Jollof Rice & Chicken\n\ud83d\udcb0 \u20a67,000\n\ud83d\ude9a Delivery in 30-45 mins\n\ud83d\udd16 Ref: FB-5518" },
    ],
  },
  {
    name: "King's Cuts",
    avatar: 'K',
    messages: [
      { from: 'bot' as const, text: "Welcome to King's Cuts! \ud83d\udc88 How can I help?" },
      { from: 'user' as const, text: 'Abeg I wan barb tomorrow for morning' },
      { from: 'bot' as const, text: "Got it! Looking up *Haircut* on *tomorrow* in the *morning* for you... \u2728" },
      { from: 'bot' as const, text: "I have these morning slots for tomorrow:\n1. 8:00 AM\n2. 9:00 AM\n3. 10:00 AM\n4. 11:00 AM\n\nWhich one works for you?" },
      { from: 'user' as const, text: '2' },
      { from: 'bot' as const, text: "\u2705 Appointment confirmed!\n\n\ud83d\udc88 Haircut\n\ud83d\udcc5 Tomorrow, 9:00 AM\n\ud83d\udccd King's Cuts\n\ud83d\udd16 Ref: BW-4821" },
    ],
  },
];

function HeroChatMockup() {
  const [demoIndex, setDemoIndex] = useState(0);
  const demo = HERO_DEMOS[demoIndex];

  useEffect(() => {
    const timer = setInterval(() => {
      setDemoIndex((prev) => (prev + 1) % HERO_DEMOS.length);
    }, 6000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="relative mx-auto w-full max-w-sm lg:mx-0">
      {/* Floating platform badges */}
      <div className="absolute -left-6 top-4 z-10 animate-bounce rounded-xl bg-white px-3 py-2 shadow-lg" style={{ animationDuration: '3s' }}>
        <div className="flex items-center gap-2">
          <span className="text-lg">&#x1F4AC;</span>
          <span className="text-xs font-bold text-gray-800">WhatsApp</span>
        </div>
      </div>
      <div className="absolute -right-4 top-1/3 z-10 animate-bounce rounded-xl bg-white px-3 py-2 shadow-lg" style={{ animationDuration: '4s', animationDelay: '1s' }}>
        <div className="flex items-center gap-2">
          <span className="text-lg">&#x1F916;</span>
          <span className="text-xs font-bold text-gray-800">AI Bot</span>
        </div>
      </div>
      <div className="absolute -left-3 bottom-16 z-10 animate-bounce rounded-xl bg-white px-3 py-2 shadow-lg" style={{ animationDuration: '3.5s', animationDelay: '0.5s' }}>
        <div className="flex items-center gap-2">
          <span className="text-lg">&#x1F4B3;</span>
          <span className="text-xs font-bold text-gray-800">Payments</span>
        </div>
      </div>

      {/* Phone mockup */}
      <div className="relative overflow-hidden rounded-[2rem] border-4 border-white/20 bg-white shadow-2xl">
        {/* WhatsApp header */}
        <div className="flex items-center gap-3 px-4 py-3" style={{ backgroundColor: '#075E54' }}>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-sm font-bold text-white">
            {demo.avatar}
          </div>
          <div>
            <p className="text-sm font-semibold text-white">{demo.name}</p>
            <p className="text-xs text-green-200">online</p>
          </div>
        </div>

        <div className="space-y-2.5 p-3" style={{ backgroundColor: '#ECE5DD', minHeight: '280px' }}>
          {demo.messages.map((msg, i) => (
            <ChatBubble key={`${demoIndex}-${i}`} from={msg.from}>{msg.text}</ChatBubble>
          ))}
        </div>

        {/* Demo switcher dots */}
        <div className="flex items-center justify-center gap-2 bg-white py-2">
          {HERO_DEMOS.map((_, i) => (
            <button
              key={i}
              onClick={() => setDemoIndex(i)}
              className={`h-2 w-2 rounded-full transition-all ${i === demoIndex ? 'w-6 bg-brand' : 'bg-gray-300'}`}
            />
          ))}
        </div>
      </div>
    </div>
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
        <svg
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div className={`grid transition-all duration-200 ${open ? 'mt-2 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
        <div className="overflow-hidden">
          <p className="text-sm leading-relaxed text-gray-600">{answer}</p>
        </div>
      </div>
    </div>
  );
}
