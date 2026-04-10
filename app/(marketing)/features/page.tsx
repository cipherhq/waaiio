import type { Metadata } from 'next';
import Link from 'next/link';
import AnimatedSection from '@/components/marketing/AnimatedSection';

export const metadata: Metadata = {
  title: 'Features — Waaiio',
  description:
    'Explore all 20+ capabilities of Waaiio — WhatsApp automation, booking, payments, ordering, ticketing, loyalty, broadcasts, analytics, and more.',
};

const CHECK = (
  <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

function FeatureCard({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="group rounded-2xl border border-gray-100 bg-white p-6 transition hover:border-brand-200 hover:shadow-lg hover:shadow-brand-50">
      <span className="text-3xl" dangerouslySetInnerHTML={{ __html: icon }} />
      <h3 className="mt-4 text-base font-semibold text-gray-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-gray-600">{desc}</p>
    </div>
  );
}

function SectionHeading({ tag, title, desc }: { tag: string; title: string; desc: string }) {
  return (
    <div className="text-center">
      <p className="text-xs font-bold uppercase tracking-widest text-brand">{tag}</p>
      <h2 className="mt-3 text-3xl font-bold text-gray-900">{title}</h2>
      <p className="mx-auto mt-3 max-w-2xl text-gray-600">{desc}</p>
    </div>
  );
}

export default function FeaturesPage() {
  return (
    <>
      {/* ── 1. Hero ── */}
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-24 lg:py-32">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />

        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-sm font-medium text-white backdrop-blur">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
            </span>
            Platform Features
          </span>

          <h1 className="mx-auto mt-8 max-w-4xl text-balance text-4xl font-extrabold leading-tight text-white sm:text-5xl lg:text-6xl">
            Everything you need to run your business on WhatsApp
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-brand-200">
            20+ built-in capabilities across automation, commerce, engagement, and analytics — all working together on the platform 2 billion people already use.
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-3">
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
        </div>
      </section>

      {/* ── 2. WhatsApp Automation ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection>
            <SectionHeading
              tag="WhatsApp Automation"
              title="Intelligent AI that never sleeps"
              desc="Your AI assistant handles conversations 24/7 — understanding natural language, slang, and multi-language messages."
            />
          </AnimatedSection>

          <AnimatedSection delay={0.1}>
            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <FeatureCard
                icon="&#x1F916;"
                title="Smart Bot"
                desc="AI-powered conversational bot that understands intent from natural language, Pidgin, slang, and mixed-language messages."
              />
              <FeatureCard
                icon="&#x2753;"
                title="FAQ Bot"
                desc="Automatically answers common questions about your business — hours, location, services, pricing — without human intervention."
              />
              <FeatureCard
                icon="&#x1F4AC;"
                title="Bot Sessions"
                desc="Persistent conversation sessions that remember context, allowing multi-step flows like booking + payment in one chat."
              />
              <FeatureCard
                icon="&#x23F0;"
                title="Smart Reminders"
                desc="Automatic WhatsApp reminders before appointments and events, reducing no-shows by up to 60%."
              />
              <FeatureCard
                icon="&#x1F3AD;"
                title="Bot Persona"
                desc="Customize your bot's name, personality, and greeting to match your brand. Customers interact with your brand, not ours."
              />
              <FeatureCard
                icon="&#x1F6AB;"
                title="Profanity Filter"
                desc="Built-in moderation that keeps conversations clean and professional, protecting your brand reputation."
              />
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 3. Booking & Scheduling ── */}
      <section className="bg-gray-50 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection delay={0.15}>
            <SectionHeading
              tag="Booking & Scheduling"
              title="Automate every appointment"
              desc="From walk-in queues to recurring bookings, handle all your scheduling needs through WhatsApp."
            />
          </AnimatedSection>

          <AnimatedSection delay={0.25}>
            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <FeatureCard
                icon="&#x1F4C5;"
                title="Appointments"
                desc="Customers book services by selecting date, time, and service type — all through a guided WhatsApp conversation."
              />
              <FeatureCard
                icon="&#x1F4C6;"
                title="Calendar Management"
                desc="View and manage all bookings from your dashboard. Block times, set availability, and handle rescheduling."
              />
              <FeatureCard
                icon="&#x1F465;"
                title="Staff Management"
                desc="Assign bookings to specific staff members. Each team member sees their own schedule and appointments."
              />
              <FeatureCard
                icon="&#x1F4CB;"
                title="Queue Management"
                desc="Let walk-in customers join a virtual queue via WhatsApp. They get notified when it's their turn."
              />
              <FeatureCard
                icon="&#x23F3;"
                title="Waitlist"
                desc="When slots are full, customers can join a waitlist and get automatically notified when a spot opens up."
              />
              <FeatureCard
                icon="&#x1F552;"
                title="Time Slots"
                desc="Configure available time slots, durations, buffers between appointments, and operating hours per service."
              />
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 4. Payments & Commerce ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection delay={0.1}>
            <SectionHeading
              tag="Payments & Commerce"
              title="Accept payments everywhere"
              desc="4 payment gateways covering 5 countries. Collect payments, process orders, and sell tickets — all inside WhatsApp."
            />
          </AnimatedSection>

          {/* Gateway callout */}
          <AnimatedSection delay={0.2} direction="left">
            <div className="mx-auto mt-10 grid max-w-3xl gap-3 sm:grid-cols-4">
              {[
                { name: 'Paystack', region: 'Nigeria, Ghana', color: 'border-blue-200 bg-blue-50/50' },
                { name: 'Square', region: 'United States', color: 'border-green-200 bg-green-50/50' },
                { name: 'Stripe', region: 'UK, Canada', color: 'border-purple-200 bg-purple-50/50' },
                { name: 'Flutterwave', region: 'Africa (alt)', color: 'border-amber-200 bg-amber-50/50' },
              ].map((gw) => (
                <div key={gw.name} className={`rounded-xl border ${gw.color} p-4 text-center`}>
                  <p className="text-sm font-semibold text-gray-900">{gw.name}</p>
                  <p className="mt-1 text-xs text-gray-500">{gw.region}</p>
                </div>
              ))}
            </div>
          </AnimatedSection>

          <AnimatedSection delay={0.3}>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <FeatureCard
                icon="&#x1F6D2;"
                title="Ordering"
                desc="Product catalog, cart management, delivery or pickup options, and checkout with inventory tracking."
              />
              <FeatureCard
                icon="&#x1F3AB;"
                title="Ticketing"
                desc="Event listings, ticket selection, availability checks, and instant purchase with QR code delivery."
              />
              <FeatureCard
                icon="&#x1F4B0;"
                title="Crowdfunding"
                desc="Campaign-based donations with progress tracking. Perfect for fundraisers, building projects, and community drives."
              />
              <FeatureCard
                icon="&#x1F501;"
                title="Recurring Billing"
                desc="Set up recurring payments for subscriptions, memberships, school fees, and monthly dues."
              />
              <FeatureCard
                icon="&#x1F4B5;"
                title="Deposits & Payouts"
                desc="Collect deposits on bookings and manage payouts to service providers, staff, or vendors."
              />
              <FeatureCard
                icon="&#x1F3F7;&#xFE0F;"
                title="Promo Codes"
                desc="Create discount codes for promotions, seasonal offers, and special events. Track redemptions in real time."
              />
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 5. Customer Engagement ── */}
      <section className="bg-gray-50 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection delay={0.1}>
            <SectionHeading
              tag="Customer Engagement"
              title="Build lasting relationships"
              desc="Keep customers coming back with loyalty rewards, targeted broadcasts, and automated follow-ups."
            />
          </AnimatedSection>

          <AnimatedSection delay={0.2}>
            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <FeatureCard
                icon="&#x1F4AC;"
                title="Live Chat"
                desc="Seamless handoff from bot to human agent when needed. View full conversation history and customer context."
              />
              <FeatureCard
                icon="&#x1F4E2;"
                title="Broadcasts"
                desc="Send targeted messages, promotions, and updates to customer segments. Schedule campaigns in advance."
              />
              <FeatureCard
                icon="&#x1F3C6;"
                title="Loyalty Program"
                desc="Reward repeat customers with points for every transaction. Configurable tiers and reward redemption."
              />
              <FeatureCard
                icon="&#x1F91D;"
                title="Referrals"
                desc="Customers share a referral link and earn rewards when friends make their first booking or purchase."
              />
              <FeatureCard
                icon="&#x2B50;"
                title="Reviews & Feedback"
                desc="Automatically request reviews after service completion. Monitor satisfaction and respond to feedback."
              />
              <FeatureCard
                icon="&#x1F514;"
                title="Notifications"
                desc="Order confirmations, payment receipts, status updates, and reminders — all delivered via WhatsApp."
              />
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 6. Analytics & Operations ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection delay={0.1}>
            <SectionHeading
              tag="Analytics & Operations"
              title="Data-driven decisions"
              desc="Real-time dashboards and reports to understand your business performance at a glance."
            />
          </AnimatedSection>

          <AnimatedSection delay={0.2}>
            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <FeatureCard
                icon="&#x1F4CA;"
                title="Dashboard"
                desc="View bookings, orders, payments, and customer activity in a clean, real-time analytics dashboard."
              />
              <FeatureCard
                icon="&#x1F4C8;"
                title="Analytics"
                desc="Track revenue trends, peak hours, popular services, customer retention, and conversion rates."
              />
              <FeatureCard
                icon="&#x1F4B1;"
                title="Financials"
                desc="Complete financial overview with transaction history, revenue breakdowns, and payout tracking."
              />
              <FeatureCard
                icon="&#x1F4DD;"
                title="Reports"
                desc="Generate detailed reports by date range, service type, staff member, or customer segment."
              />
              <FeatureCard
                icon="&#x1F4E4;"
                title="CSV Export"
                desc="Export any data — bookings, transactions, customers, analytics — to CSV for your own analysis."
              />
              <FeatureCard
                icon="&#x1F50D;"
                title="Activity Log"
                desc="Full audit trail of every action taken on your account — bookings, payments, settings changes, and more."
              />
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 7. Customization & Integrations ── */}
      <section className="bg-brand py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection delay={0.1}>
            <div className="text-center">
              <p className="text-xs font-bold uppercase tracking-widest text-brand-200">Customization & Integrations</p>
              <h2 className="mt-3 text-3xl font-bold text-white">
                Make it truly yours
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-brand-200">
                White-label branding, custom pages, QR codes, webhooks, and multi-location support.
              </p>
            </div>
          </AnimatedSection>

          <AnimatedSection delay={0.2}>
            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { icon: '&#x1F310;', title: 'Custom Pages', desc: 'Create branded landing pages for your services, menus, and catalogs — shareable via link or QR code.' },
                { icon: '&#x1F4F1;', title: 'QR Codes', desc: 'Auto-generated QR codes that link directly to your WhatsApp bot. Print on flyers, receipts, and business cards.' },
                { icon: '&#x1F517;', title: 'Webhooks', desc: 'Connect Waaiio to your existing tools with real-time webhook notifications for bookings, payments, and orders.' },
                { icon: '&#x1F3E2;', title: 'Multi-Location', desc: 'Manage multiple branches or locations from a single account. Each location gets its own schedule and settings.' },
                { icon: '&#x2728;', title: 'White-Label', desc: 'Remove all Waaiio branding. Your customers see only your brand name, logo, and colors throughout.' },
                { icon: '&#x1F4CB;', title: 'KYC Verification', desc: 'Built-in identity verification for businesses that need to verify customer identity before transactions.' },
              ].map((f) => (
                <div key={f.title} className="group rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur transition hover:bg-white/10">
                  <span className="text-3xl" dangerouslySetInnerHTML={{ __html: f.icon }} />
                  <h3 className="mt-4 text-base font-semibold text-white">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-brand-200">{f.desc}</p>
                </div>
              ))}
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* ── 8. CTA ── */}
      <section className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection delay={0.1}>
            <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-brand-900 via-brand to-brand-700 p-12 text-center lg:p-16">
              <h2 className="text-3xl font-bold text-white lg:text-4xl">
                Ready to unlock every feature?
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-lg text-brand-200">
                Start with a 7-day free trial. No credit card required. Upgrade anytime to unlock more capabilities.
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
