import type { Metadata } from 'next';
import Link from 'next/link';
import AnimatedSection from '@/components/marketing/AnimatedSection';
import CounterAnimation from '@/components/marketing/CounterAnimation';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'About Waaiio',
  description:
    'waaiio — WA (WhatsApp) + AI (Artificial Intelligence) + IO (Input & Output). Learn why we built the platform and how it solves real business problems.',
};

export default function AboutPage() {
  return (
    <>
      {/* ── 1. Hero — Brand Breakdown ── */}
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-24 lg:py-32">
        {/* Decorative blobs */}
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-whatsapp/5 blur-3xl" />

        <div className="relative mx-auto max-w-6xl px-4">
          <div className="text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-sm font-medium text-white backdrop-blur">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
              </span>
              About Us
            </span>

            <h1 className="mx-auto mt-8 max-w-4xl text-balance text-4xl font-extrabold leading-tight text-white sm:text-5xl lg:text-6xl">
              The name says it all.
            </h1>

            {/* Brand Name Visual Breakdown */}
            <div className="mx-auto mt-14 max-w-4xl">
              <div className="grid gap-4 sm:grid-cols-3">
                {/* WA */}
                <div className="group rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur transition hover:border-whatsapp/40 hover:bg-white/10">
                  <div className="text-6xl font-black tracking-tight text-whatsapp lg:text-7xl">
                    wa
                  </div>
                  <div className="mt-4 h-px w-12 bg-whatsapp/40 mx-auto" />
                  <p className="mt-4 text-lg font-semibold text-white">WhatsApp</p>
                  <p className="mt-2 text-sm leading-relaxed text-brand-200">
                    The channel. Where 2 billion people already live, chat, and do business every day.
                  </p>
                </div>

                {/* AI */}
                <div className="group rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur transition hover:border-accent/40 hover:bg-white/10">
                  <div className="text-6xl font-black tracking-tight text-accent lg:text-7xl">
                    ai
                  </div>
                  <div className="mt-4 h-px w-12 bg-accent/40 mx-auto" />
                  <p className="mt-4 text-lg font-semibold text-white">Artificial Intelligence</p>
                  <p className="mt-2 text-sm leading-relaxed text-brand-200">
                    The brain. Smart intent detection that understands natural language, slang, and Pidgin.
                  </p>
                </div>

                {/* IO */}
                <div className="group rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur transition hover:border-brand-300/40 hover:bg-white/10">
                  <div className="text-6xl font-black tracking-tight text-brand-300 lg:text-7xl">
                    io
                  </div>
                  <div className="mt-4 h-px w-12 bg-brand-300/40 mx-auto" />
                  <p className="mt-4 text-lg font-semibold text-white">Input &amp; Output</p>
                  <p className="mt-2 text-sm leading-relaxed text-brand-200">
                    The flow. Customers send a message in, your business sends bookings, payments, and confirmations out.
                  </p>
                </div>
              </div>

              {/* Combined brand mark */}
              <div className="mt-10 flex items-center justify-center gap-1">
                <span className="text-4xl font-black text-whatsapp sm:text-5xl">wa</span>
                <span className="text-4xl font-black text-accent sm:text-5xl">ai</span>
                <span className="text-4xl font-black text-brand-300 sm:text-5xl">io</span>
              </div>
              <p className="mt-3 text-sm text-brand-200">
                WhatsApp + AI + Input/Output = the complete business automation platform.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── 2. The Problem ── */}
      <section className="bg-white py-20 lg:py-24">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection>
            <div className="text-center">
              <p className="text-xs font-bold uppercase tracking-widest text-brand">The Problem</p>
              <h2 className="mt-3 text-3xl font-bold text-gray-900 lg:text-4xl">
                Businesses are losing money every day
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-lg text-gray-600">
                Across Africa and emerging markets, millions of businesses face the same challenges &mdash; and most don&apos;t have the tools to solve them.
              </p>
            </div>
          </AnimatedSection>

          <AnimatedSection delay={0.15}>
          <div className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: (
                  <svg aria-hidden="true" className="h-6 w-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                ),
                title: 'Missed calls = lost revenue',
                desc: 'Customers call after hours, on weekends, and during busy periods. Every missed call is a missed sale.',
              },
              {
                icon: (
                  <svg aria-hidden="true" className="h-6 w-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ),
                title: 'Manual systems fail',
                desc: 'Double bookings, forgotten orders, lost receipts. Pen-and-paper and spreadsheets can\'t keep up.',
              },
              {
                icon: (
                  <svg aria-hidden="true" className="h-6 w-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ),
                title: 'Custom apps cost too much',
                desc: 'Small businesses can\'t afford websites or custom apps. They need automation that fits their budget.',
              },
              {
                icon: (
                  <svg aria-hidden="true" className="h-6 w-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                ),
                title: 'No centralized system',
                desc: 'Small businesses in emerging markets lack a unified platform for bookings, payments, and orders.',
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-2xl border border-red-100 bg-red-50/30 p-6 transition hover:border-red-200 hover:shadow-md"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-100">
                  {item.icon}
                </div>
                <h3 className="mt-4 text-base font-semibold text-gray-900">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-gray-600">{item.desc}</p>
              </div>
            ))}
          </div>
          </AnimatedSection>

          {/* Extended pain points */}
          <AnimatedSection delay={0.25}>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: (
                  <svg aria-hidden="true" className="h-6 w-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                  </svg>
                ),
                title: 'Faith orgs struggle digitally',
                desc: 'Churches and mosques need modern ways to collect tithes, offerings, zakat, and donations — but lack the tools.',
              },
              {
                icon: (
                  <svg aria-hidden="true" className="h-6 w-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                ),
                title: 'Schools waste hours',
                desc: 'Manual fee collection, endless follow-ups, and no visibility into who has paid. Hours wasted every week.',
              },
              {
                icon: (
                  <svg aria-hidden="true" className="h-6 w-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
                  </svg>
                ),
                title: 'Ticket sales lost to friction',
                desc: 'Event organizers lose sales because buying tickets requires too many steps. People give up.',
              },
              {
                icon: (
                  <svg aria-hidden="true" className="h-6 w-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                ),
                title: 'WhatsApp can\'t be automated',
                desc: 'WhatsApp is where 2 billion people are &mdash; but businesses can\'t automate conversations on it. Until now.',
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-2xl border border-red-100 bg-red-50/30 p-6 transition hover:border-red-200 hover:shadow-md"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-100">
                  {item.icon}
                </div>
                <h3 className="mt-4 text-base font-semibold text-gray-900">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-gray-600">{item.desc}</p>
              </div>
            ))}
          </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 3. Why We Built waaiio ── */}
      <section className="bg-gray-50 py-20 lg:py-24">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection>
            <div className="text-center">
              <p className="text-xs font-bold uppercase tracking-widest text-brand">The Solution</p>
              <h2 className="mt-3 text-3xl font-bold text-gray-900 lg:text-4xl">
                Why we built waaiio
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-lg text-gray-600">
                We built waaiio because every business deserves the power of automation &mdash; not just the ones that can afford expensive software.
              </p>
            </div>
          </AnimatedSection>

          <AnimatedSection delay={0.15}>
          <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: (
                  <svg aria-hidden="true" className="h-7 w-7 text-whatsapp" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z" />
                  </svg>
                ),
                title: 'Meet customers where they are',
                desc: 'WhatsApp is the most-used app in Africa, Latin America, and much of the world. We bring business automation to the platform people already trust.',
                color: 'border-green-200 bg-green-50/50',
                iconBg: 'bg-green-100',
              },
              {
                icon: (
                  <svg aria-hidden="true" className="h-7 w-7 text-accent-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                ),
                title: 'AI that truly understands',
                desc: 'Our AI handles natural language, slang, Pidgin English, and multi-language messages. It doesn\'t just match keywords &mdash; it understands intent.',
                color: 'border-amber-200 bg-amber-50/50',
                iconBg: 'bg-amber-100',
              },
              {
                icon: (
                  <svg aria-hidden="true" className="h-7 w-7 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                ),
                title: '40+ industries, zero coding',
                desc: 'Pre-built automation flows for churches, salons, restaurants, schools, clinics, shops, NGOs, events, and dozens more. Just pick your category and go.',
                color: 'border-brand-200 bg-brand-50/50',
                iconBg: 'bg-brand-50',
              },
              {
                icon: (
                  <svg aria-hidden="true" className="h-7 w-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                  </svg>
                ),
                title: 'Integrated payments',
                desc: 'Paystack for Africa (Nigeria, Ghana). Square for the US. Stripe for UK and Canada. Payments happen inside the WhatsApp conversation.',
                color: 'border-green-200 bg-green-50/50',
                iconBg: 'bg-green-100',
              },
              {
                icon: (
                  <svg aria-hidden="true" className="h-7 w-7 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                ),
                title: 'Works 24/7, never sleeps',
                desc: 'Your AI assistant takes bookings at 2 AM, processes orders on weekends, and handles payments on holidays. Never misses a customer again.',
                color: 'border-blue-200 bg-blue-50/50',
                iconBg: 'bg-blue-100',
              },
              {
                icon: (
                  <svg aria-hidden="true" className="h-7 w-7 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ),
                title: 'Affordable for every size',
                desc: 'Start free. No setup fees, no expensive subscriptions. Pay-as-you-go pricing means even a one-person shop can automate like a Fortune 500.',
                color: 'border-purple-200 bg-purple-50/50',
                iconBg: 'bg-purple-100',
              },
            ].map((item) => (
              <div
                key={item.title}
                className={`rounded-2xl border ${item.color} p-7 transition hover:shadow-lg`}
              >
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${item.iconBg}`}>
                  {item.icon}
                </div>
                <h3 className="mt-5 text-base font-semibold text-gray-900">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-gray-600">{item.desc}</p>
              </div>
            ))}
          </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 4. Our Mission ── */}
      <section className="bg-brand py-20 lg:py-24">
        <div className="relative mx-auto max-w-4xl px-4 text-center">
          {/* Decorative elements */}
          <div className="pointer-events-none absolute -left-20 top-0 h-40 w-40 rounded-full bg-accent/10 blur-3xl" />
          <div className="pointer-events-none absolute -right-20 bottom-0 h-40 w-40 rounded-full bg-whatsapp/10 blur-3xl" />

          <AnimatedSection>
            <p className="relative text-xs font-bold uppercase tracking-widest text-brand-200">Our Mission</p>
            <h2 className="relative mt-6 text-3xl font-extrabold leading-tight text-white lg:text-5xl">
              Democratizing business automation for every entrepreneur, everywhere.
            </h2>
            <p className="relative mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-brand-200">
              We believe a barber in Lagos deserves the same automation power as a Fortune 500 company in New York. We believe a church in Accra should collect offerings as seamlessly as a tech startup in London collects payments. We believe a school in Abuja should never waste another hour chasing fees manually.
            </p>
            <p className="relative mt-6 text-lg font-semibold text-accent">
              waaiio makes that possible &mdash; on the app the world already uses.
            </p>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 5. Countries & Stats ── */}
      <section className="bg-white py-20 lg:py-24">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection>
            <div className="text-center">
              <p className="text-xs font-bold uppercase tracking-widest text-brand">Global Reach</p>
              <h2 className="mt-3 text-3xl font-bold text-gray-900 lg:text-4xl">
                Live in 5 countries and growing
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-gray-600">
                Localized payment gateways, currencies, and language support for every market we serve.
              </p>
            </div>
          </AnimatedSection>

          <AnimatedSection delay={0.15}>
          <div className="mt-14 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { flag: '\ud83c\uddf3\ud83c\uddec', name: 'Nigeria', gateway: 'Paystack', currency: 'NGN', status: 'Live' },
              { flag: '\ud83c\uddfa\ud83c\uddf8', name: 'United States', gateway: 'Square', currency: 'USD', status: 'Live' },
              { flag: '\ud83c\uddec\ud83c\udde7', name: 'United Kingdom', gateway: 'Stripe', currency: 'GBP', status: 'Live' },
              { flag: '\ud83c\udde8\ud83c\udde6', name: 'Canada', gateway: 'Stripe', currency: 'CAD', status: 'Live' },
              { flag: '\ud83c\uddec\ud83c\udded', name: 'Ghana', gateway: 'Paystack', currency: 'GHS', status: 'Live' },
            ].map((country) => (
              <div
                key={country.name}
                className="group flex flex-col items-center rounded-2xl border border-gray-100 bg-gray-50/50 p-6 text-center transition hover:border-brand-200 hover:shadow-lg"
              >
                <span className="text-5xl">{country.flag}</span>
                <h3 className="mt-4 text-base font-semibold text-gray-900">{country.name}</h3>
                <div className="mt-3 space-y-1.5">
                  <span className="inline-block rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand">
                    {country.gateway}
                  </span>
                  <p className="text-xs text-gray-500">{country.currency}</p>
                </div>
                <div className="mt-3 flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
                  </span>
                  <span className="text-xs font-medium text-green-600">{country.status}</span>
                </div>
              </div>
            ))}
          </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── Stats Bar ── */}
      <section className="bg-gray-900 py-14">
        <AnimatedSection>
          <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-4 text-center md:grid-cols-5">
            <div>
              <p className="text-3xl font-extrabold text-white"><CounterAnimation target={50} suffix="+" /></p>
              <p className="mt-1 text-sm text-gray-400">Business Categories</p>
            </div>
            <div>
              <p className="text-3xl font-extrabold text-white"><CounterAnimation target={5} /></p>
              <p className="mt-1 text-sm text-gray-400">Countries Supported</p>
            </div>
            <div>
              <p className="text-3xl font-extrabold text-white"><CounterAnimation target={5} /></p>
              <p className="mt-1 text-sm text-gray-400">Payment Gateways</p>
            </div>
            <div>
              <p className="text-3xl font-extrabold text-white"><CounterAnimation target={20} suffix="+" /></p>
              <p className="mt-1 text-sm text-gray-400">Capabilities</p>
            </div>
            <div>
              <p className="text-3xl font-extrabold text-white">24/7</p>
              <p className="mt-1 text-sm text-gray-400">Always Available</p>
            </div>
          </div>
        </AnimatedSection>
      </section>

      {/* ── Founder ── */}
      <section className="bg-gray-50 py-20 lg:py-24">
        <div className="mx-auto max-w-4xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">The Team</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 lg:text-4xl">
              Built by people who understand the problem
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-gray-600">
              Waaiio was founded by Babajide Adepoju, a software engineer who saw firsthand how businesses
              in Nigeria, Ghana, and the diaspora were losing customers to unanswered WhatsApp messages
              and manual processes.
            </p>
            <p className="mx-auto mt-4 max-w-2xl text-gray-600">
              After watching a barbershop lose 40% of after-hours booking requests and a church spend
              5 hours a week reconciling offering payments, the mission became clear: give every business
              the automation tools that only large enterprises could afford &mdash; on the app their customers
              already use every day.
            </p>
            <p className="mx-auto mt-6 max-w-xl text-sm text-gray-500">
              Waaiio is a Meta Verified Technology Provider, headquartered in the United States
              with operations across West Africa.
            </p>
          </AnimatedSection>
        </div>
      </section>

      {/* ── Security & Trust ── */}
      <section className="bg-white py-20 lg:py-24">
        <div className="mx-auto max-w-5xl px-4">
          <AnimatedSection className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">Security</p>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 lg:text-4xl">
              Your data is safe with us
            </h2>
          </AnimatedSection>
          <AnimatedSection delay={0.1}>
            <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { icon: '🔒', title: 'Bank-Grade Encryption', desc: 'All data encrypted in transit (TLS 1.3) and at rest. Payment credentials never touch our servers.' },
                { icon: '🛡️', title: 'Row-Level Security', desc: 'Every database table is protected with row-level security. Your data is completely isolated from other businesses.' },
                { icon: '✅', title: 'Webhook Verification', desc: 'All payment webhooks are verified with cryptographic signatures (HMAC-SHA256). No unsigned requests are processed.' },
                { icon: '🌍', title: 'GDPR Compliant', desc: 'We follow GDPR-compliant data practices including data minimization, right to deletion, and transparent processing.' },
                { icon: '🔑', title: 'Meta Verified Provider', desc: 'Waaiio is a verified Meta Technology Provider with approved access to the WhatsApp Business Platform.' },
                { icon: '⚡', title: 'Rate Limited & Monitored', desc: 'All API endpoints are rate limited. Suspicious activity is flagged and blocked automatically.' },
              ].map(item => (
                <div key={item.title} className="rounded-2xl border border-gray-100 bg-white p-6 transition hover:shadow-md">
                  <span className="text-2xl">{item.icon}</span>
                  <h3 className="mt-3 text-base font-semibold text-gray-900">{item.title}</h3>
                  <p className="mt-2 text-sm text-gray-600">{item.desc}</p>
                </div>
              ))}
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection delay={0.1}>
            <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-brand-900 via-brand to-brand-700 p-12 text-center lg:p-16">
              <h2 className="text-3xl font-bold text-white lg:text-4xl">
                Ready to automate your business on WhatsApp?
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-lg text-brand-200">
                Join businesses across 5 countries already saving time and growing revenue with waaiio.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Link
                  href="/get-started"
                  className="rounded-xl bg-accent px-8 py-4 text-sm font-bold text-gray-900 shadow-lg shadow-accent/25 transition hover:bg-accent-400"
                >
                  Get Started Free
                </Link>
                <Link
                  href="/pricing"
                  className="rounded-xl border border-white/30 px-8 py-4 text-sm font-semibold text-white transition hover:bg-white/10"
                >
                  View Pricing
                </Link>
              </div>
            </div>
          </AnimatedSection>
        </div>
      </section>
    </>
  );
}
