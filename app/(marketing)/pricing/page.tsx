'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import AnimatedSection from '@/components/marketing/AnimatedSection';
import { formatCurrency, getPricingTiers, TIER_FEATURES, type CountryCode, type SubscriptionTier } from '@/lib/constants';
import { CAPABILITIES, CAPABILITY_TIER_REQUIREMENTS, type CapabilityId } from '@/lib/capabilities/types';
import { loadCountries, getCountryList, type CountryRow } from '@/lib/countries';

export default function PricingPage() {
  const [country, setCountry] = useState<CountryCode>('NG');
  const [isAnnual, setIsAnnual] = useState(false);
  const [billingVolume, setBillingVolume] = useState(200);
  const [countryList, setCountryList] = useState<CountryRow[]>(getCountryList());
  const tiers = getPricingTiers(country);

  useEffect(() => {
    loadCountries().then(() => setCountryList(getCountryList()));
  }, []);

  const avgTransaction: Record<CountryCode, number> = { NG: 5000, US: 40, GB: 35, CA: 45, GH: 50 };
  const avgTx = avgTransaction[country] || 40;
  const feeEstimates = {
    free: Math.round(billingVolume * (2.5 / 100) * avgTx + billingVolume * tiers.free.feeFlat),
    growth: Math.round(billingVolume * (1.5 / 100) * avgTx + billingVolume * tiers.growth.feeFlat),
    business: Math.round(billingVolume * (1.0 / 100) * avgTx + billingVolume * tiers.business.feeFlat),
  };

  return (
    <>
      {/* Hero */}
      <section className="bg-gradient-to-b from-brand-50/50 to-white py-16 lg:py-20">
        <div className="mx-auto max-w-6xl px-4 text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-brand">Pricing</p>
          <h1 className="mt-3 text-4xl font-extrabold text-gray-900 lg:text-5xl">
            Simple, transparent pricing
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-gray-600">
            30-day free trial with zero fees, then 2.5% per transaction. No monthly fees on Starter. Free reservations don&apos;t count.
          </p>

          {/* Country picker */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
            {countryList.map((c) => (
              <button
                key={c.code}
                onClick={() => setCountry(c.code)}
                className={`flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition ${
                  country === c.code
                    ? 'border-brand bg-brand-50 text-brand'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                <span>{c.flag}</span>
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="bg-white py-16">
        <AnimatedSection>
          <div className="mx-auto max-w-6xl px-4">
            {/* Billing toggle */}
            <div className="mb-8 flex items-center justify-center gap-3">
              <span className={`text-sm font-medium ${!isAnnual ? 'text-gray-900' : 'text-gray-400'}`}>Monthly</span>
              <button
                role="switch"
                aria-checked={isAnnual}
                aria-label="Toggle annual billing"
                onClick={() => setIsAnnual(!isAnnual)}
                className={`relative h-7 w-14 rounded-full transition ${isAnnual ? 'bg-brand' : 'bg-gray-300'}`}
              >
                <div className="absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-md transition-all duration-200" style={{ left: isAnnual ? '30px' : '2px' }} />
              </button>
              <span className={`text-sm font-medium ${isAnnual ? 'text-gray-900' : 'text-gray-400'}`}>
                Annual <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700">Save 20%</span>
              </span>
            </div>

            <div className="grid gap-8 lg:grid-cols-3">
              <div>
                <TierCard
                  tier="free"
                  name={TIER_FEATURES.free.marketingName}
                  price="Free"
                  priceNote="No monthly fee"
                  description={TIER_FEATURES.free.description}
                  features={tiers.free.features}
                  cta={{ label: 'Start Free Trial', href: '/get-started' }}
                  country={country}
                />
                <p className="mt-3 rounded-lg bg-gray-50 px-4 py-3 text-center text-xs text-gray-500">
                  After trial: 2.5% per paid transaction. Free bookings (no deposit) are always free.
                </p>
              </div>
              <TierCard
                tier="growth"
                name={TIER_FEATURES.growth.marketingName}
                price={formatCurrency(isAnnual ? Math.round(tiers.growth.price * 0.8) : tiers.growth.price, country)}
                priceNote={isAnnual ? '/mo billed annually' : '/month'}
                description={TIER_FEATURES.growth.description}
                highlight
                features={tiers.growth.features}
                cta={{ label: 'Get Started', href: '/get-started?plan=growth', gold: true }}
                country={country}
              />
              <TierCard
                tier="business"
                name={TIER_FEATURES.business.marketingName}
                price={formatCurrency(isAnnual ? Math.round(tiers.business.price * 0.8) : tiers.business.price, country)}
                priceNote={isAnnual ? '/mo billed annually' : '/month'}
                description={TIER_FEATURES.business.description}
                features={tiers.business.features}
                cta={{ label: 'Get Started', href: '/get-started?plan=business' }}
                country={country}
              />
            </div>
          </div>
        </AnimatedSection>
      </section>

      {/* Feature Comparison Table */}
      <section className="border-t border-gray-100 bg-white py-16">
        <AnimatedSection delay={0.1}>
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="text-center text-2xl font-bold text-gray-900">Compare plans</h2>
            <p className="mt-2 text-center text-gray-600">
              See what&apos;s included in each plan at a glance
            </p>

            <div className="mt-10 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="py-3 pr-4 text-left font-medium text-gray-500">Feature</th>
                    {(['free', 'growth', 'business'] as SubscriptionTier[]).map(tier => (
                      <th key={tier} className="px-4 py-3 text-center font-semibold text-gray-900">
                        {TIER_FEATURES[tier].marketingName}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {/* Limits section */}
                  <tr className="bg-gray-50">
                    <td colSpan={4} className="px-0 py-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                      Limits &amp; Pricing
                    </td>
                  </tr>
                  <CompareRow
                    label="Monthly bookings"
                    values={['Up to 50', 'Up to 500', 'Unlimited']}
                  />
                  <CompareRow
                    label="Transaction fee"
                    values={[
                      `${TIER_FEATURES.free.feePercentage}% + flat fee`,
                      `${TIER_FEATURES.growth.feePercentage}% + flat fee`,
                      `${TIER_FEATURES.business.feePercentage}% + flat fee`,
                    ]}
                  />
                  <CompareRow
                    label="Broadcasts / month"
                    values={['—', '10 (500 recipients)', 'Unlimited']}
                  />
                  <CompareRow
                    label="Direct bank transfer"
                    values={[false, true, true]}
                  />
                  <CompareRow
                    label="Whitelabel branding"
                    values={[false, false, true]}
                  />

                  {/* Capabilities section */}
                  <tr className="bg-gray-50">
                    <td colSpan={4} className="px-0 py-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                      Capabilities
                    </td>
                  </tr>
                  {CAPABILITIES.map(cap => {
                    const req = CAPABILITY_TIER_REQUIREMENTS[cap.id];
                    const tierRank: Record<string, number> = { free: 0, growth: 1, business: 2 };
                    return (
                      <CompareRow
                        key={cap.id}
                        label={`${cap.icon} ${cap.label}`}
                        values={(['free', 'growth', 'business'] as SubscriptionTier[]).map(
                          t => tierRank[t] >= tierRank[req]
                        )}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </AnimatedSection>
      </section>

      {/* Billing Calculator */}
      <section className="border-t border-gray-100 bg-gray-50 py-16">
        <AnimatedSection delay={0.1}>
        <div className="mx-auto max-w-4xl px-4">
          <div className="rounded-2xl border border-gray-200 bg-white p-8 lg:p-10">
            <h2 className="text-xl font-bold text-gray-900">Billing Calculator</h2>
            <p className="mt-1 text-sm text-gray-600">
              Estimate your monthly fees based on transaction volume
            </p>

            <div className="mt-8">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">
                  Monthly transactions
                </label>
                <span className="rounded-full bg-brand-50 px-3 py-1 text-sm font-bold text-brand">
                  {billingVolume}
                </span>
              </div>
              <input
                type="range"
                min={10}
                max={1000}
                step={10}
                value={billingVolume}
                onChange={(e) => setBillingVolume(Number(e.target.value))}
                className="mt-3 w-full accent-brand"
              />
              <div className="flex justify-between text-xs text-gray-400">
                <span>10</span>
                <span>500</span>
                <span>1,000</span>
              </div>
            </div>

            <p className="mt-6 text-xs text-gray-500">
              Assuming average transaction of {formatCurrency(avgTx, country)}
            </p>

            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              {([
                { tier: 'free' as SubscriptionTier, name: TIER_FEATURES.free.marketingName, monthly: 0 },
                { tier: 'growth' as SubscriptionTier, name: TIER_FEATURES.growth.marketingName, monthly: tiers.growth.price },
                { tier: 'business' as SubscriptionTier, name: TIER_FEATURES.business.marketingName, monthly: tiers.business.price },
              ]).map((plan) => {
                const fee = feeEstimates[plan.tier];
                const total = plan.monthly + fee;
                return (
                  <div
                    key={plan.tier}
                    className={`rounded-xl border p-4 ${plan.tier === 'growth' ? 'border-brand bg-brand-50/30' : 'border-gray-200'}`}
                  >
                    <p className="text-xs font-semibold text-gray-500">{plan.name}</p>
                    <p className="mt-2 text-xl font-bold text-gray-900">{formatCurrency(total, country)}</p>
                    <p className="text-xs text-gray-500">/month platform cost</p>
                    <div className="mt-3 space-y-1 text-xs text-gray-600">
                      <p>Subscription: {formatCurrency(plan.monthly, country)}</p>
                      <p>Transaction fees: ~{formatCurrency(fee, country)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        </AnimatedSection>
      </section>

      {/* How Messages Are Billed */}
      <section className="bg-white py-16">
        <AnimatedSection delay={0.1}>
          <div className="mx-auto max-w-4xl px-4">
            <h2 className="text-center text-2xl font-bold text-gray-900">
              How billing works
            </h2>
            <p className="mt-2 text-center text-gray-600">
              Transparent, pay-as-you-go pricing on top of your chosen plan
            </p>

            <div className="mt-12 grid gap-8 sm:grid-cols-3">
              <BillingStep
                number="1"
                title="Choose a plan"
                desc="Pick Starter (free), Pro, or Premium based on your volume needs. Each plan has different per-transaction rates."
              />
              <BillingStep
                number="2"
                title="Customers transact"
                desc="When customers book, pay, order, or buy tickets through your WhatsApp bot, a small platform fee is applied to each transaction."
              />
              <BillingStep
                number="3"
                title="Get paid instantly"
                desc="Payments go directly to your Paystack, Stripe, or Square account. Platform fees are deducted automatically — no invoices to worry about."
              />
            </div>
          </div>
        </AnimatedSection>
      </section>

      {/* ROI Calculator */}
      <section className="bg-white py-16">
        <AnimatedSection>
          <div className="mx-auto max-w-2xl px-4">
            <h2 className="text-center text-2xl font-bold text-gray-900">
              Calculate your ROI
            </h2>
            <p className="mt-2 text-center text-gray-600">
              See how much Waaiio can earn for you
            </p>
            <RoiCalculator country={country} />
          </div>
        </AnimatedSection>
      </section>

      {/* Best for Business Feature Cards */}
      <section className="bg-gray-50 py-16">
        <AnimatedSection>
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="text-center text-2xl font-bold text-gray-900">
              Best for everyone
            </h2>
            <p className="mt-2 text-center text-gray-600">
              Features that make Waaiio the go-to WhatsApp automation platform
            </p>

            <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { icon: '&#x1F4AC;', title: 'WhatsApp Native', desc: 'Customers interact on the app they use daily. No downloads, no links, no friction.' },
                { icon: '&#x1F3ED;', title: '40+ Industries', desc: 'Churches, mosques, salons, clinics, schools, shops, NGOs, events — pre-built flows for every category.' },
                { icon: '&#x1F30D;', title: '5 Countries', desc: 'Nigeria, US, UK, Canada & Ghana with localized pricing and payment gateways.' },
                { icon: '&#x1F916;', title: 'AI Intelligence', desc: 'Smart intent detection, auto-upsell, multi-language support including Pidgin.' },
              ].map((f) => (
                <div key={f.title} className="rounded-2xl border border-gray-100 bg-white p-6">
                  <span className="text-3xl" dangerouslySetInnerHTML={{ __html: f.icon }} />
                  <h3 className="mt-3 text-sm font-semibold text-gray-900">{f.title}</h3>
                  <p className="mt-1 text-sm text-gray-600">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </AnimatedSection>
      </section>

      {/* Case Study */}
      <section className="bg-white py-16">
        <AnimatedSection>
          <div className="mx-auto max-w-4xl px-4">
            <div className="overflow-hidden rounded-2xl border border-gray-100 bg-gradient-to-br from-brand-50/50 to-white lg:flex">
              <div className="flex-1 p-8 lg:p-10">
                <p className="text-xs font-bold uppercase tracking-widest text-brand">Case Study</p>
                <h3 className="mt-3 text-xl font-bold text-gray-900">
                  King&apos;s Cuts Barbershop, Lagos
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-gray-600">
                  &ldquo;Before Waaiio, we were missing nearly half our booking requests that came in after hours.
                  Within 3 months of going live, we captured every single one. Revenue went up 30%,
                  and our barbers love that the schedule is always organized.&rdquo;
                </p>
                <p className="mt-3 text-sm font-semibold text-gray-900">— Adebayo O., Owner</p>
              </div>
              <div className="grid grid-cols-2 gap-px border-t border-gray-100 bg-gray-100 lg:w-64 lg:border-l lg:border-t-0">
                {[
                  { value: '+30%', label: 'Revenue' },
                  { value: '0', label: 'Missed Bookings' },
                  { value: '60%', label: 'Less No-Shows' },
                  { value: '24/7', label: 'Availability' },
                ].map((s) => (
                  <div key={s.label} className="bg-white p-4 text-center">
                    <p className="text-lg font-bold text-brand">{s.value}</p>
                    <p className="text-xs text-gray-500">{s.label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </AnimatedSection>
      </section>

      {/* Pricing FAQ */}
      <section className="bg-gray-50 py-16">
        <AnimatedSection>
          <div className="mx-auto max-w-3xl px-4">
            <h2 className="text-center text-2xl font-bold text-gray-900">
              Pricing FAQ
            </h2>

            <div className="mt-10 space-y-0">
              <PricingFaqItem
                question="Can I switch plans later?"
                answer="Absolutely. You can upgrade or downgrade at any time from your dashboard settings. Changes take effect immediately."
              />
              <PricingFaqItem
                question="What happens after my 30-day trial?"
                answer="After 30 days, the Starter plan's per-transaction fees kick in (2.5% + flat fee). Your bot keeps working — there's no interruption."
              />
              <PricingFaqItem
                question="Are there any hidden fees?"
                answer="No. You pay your plan subscription (if any) plus the per-transaction fees shown. Payment gateway fees (Paystack/Stripe/Square) are separate and go directly to the gateway."
              />
              <PricingFaqItem
                question="Do I need a separate payment gateway account?"
                answer="Yes. During onboarding, we'll guide you to connect your Paystack (NG/GH), Square (US), or Stripe (UK/CA) account so payments go directly to you."
              />
              <PricingFaqItem
                question="What counts as a 'transaction'?"
                answer="Any booking, payment, order, or ticket sale processed through your WhatsApp bot. Free reservations (no deposit) don't count as paid transactions."
              />
              <PricingFaqItem
                question="Is there a setup fee?"
                answer="No. Setup is free. Our onboarding wizard walks you through everything in under 5 minutes."
              />
              <PricingFaqItem
                question="Can I cancel at any time?"
                answer="Yes. All plans are month-to-month with no lock-in contracts. Cancel from your dashboard and your bot simply stops at the end of the billing period."
              />
            </div>
          </div>
        </AnimatedSection>
      </section>

      {/* Final CTA */}
      <section className="bg-white py-16">
        <AnimatedSection>
          <div className="mx-auto max-w-4xl px-4 text-center">
            <div className="rounded-3xl bg-gradient-to-br from-brand-900 via-brand to-brand-700 p-10 lg:p-14">
              <h2 className="text-2xl font-bold text-white lg:text-3xl">
                Start automating today
              </h2>
              <p className="mx-auto mt-3 max-w-lg text-brand-200">
                30-day free trial. No credit card. No setup fees. No risk.
              </p>
              <Link
                href="/get-started"
                className="mt-6 inline-block rounded-xl bg-accent px-8 py-4 text-sm font-bold text-gray-900 shadow-lg shadow-accent/25 transition hover:bg-accent-400"
              >
                Get Started Free
              </Link>
            </div>
          </div>
        </AnimatedSection>
      </section>
    </>
  );
}

/* ─── Local Components ─── */

function TierCard({
  name,
  price,
  priceNote,
  description,
  features,
  highlight,
  cta,
  tier,
  country,
}: {
  name: string;
  price: string;
  priceNote: string;
  description: string;
  features: string[];
  highlight?: boolean;
  cta: { label: string; href: string; gold?: boolean };
  tier: SubscriptionTier;
  country: CountryCode;
}) {
  return (
    <motion.div
      whileHover={{ y: -8, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.15)' }}
      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
    >
      <div
        className={`relative flex flex-col rounded-2xl border p-8 h-full ${
          highlight
            ? 'border-brand bg-white ring-2 ring-brand shadow-xl shadow-brand-100/50'
            : 'border-gray-200 bg-white'
        }`}
      >
        {highlight && (
          <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand px-4 py-1 text-xs font-bold text-white">
            Most Popular
          </span>
        )}
        <h3 className="text-lg font-bold text-gray-900">{name}</h3>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
        <div className="mt-6">
          <span className="text-4xl font-extrabold text-gray-900">{price}</span>
          <span className="text-sm text-gray-500">{priceNote}</span>
        </div>
        <ul className="mt-8 space-y-3 flex-1">
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
        <div className="mt-8">
          <Link
            href={cta.href}
            className={`block rounded-xl px-4 py-3.5 text-center text-sm font-bold transition ${
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
    </motion.div>
  );
}

function BillingStep({ number, title, desc }: { number: string; title: string; desc: string }) {
  return (
    <div className="text-center">
      <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
        {number}
      </span>
      <h3 className="mt-3 text-sm font-semibold text-gray-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-gray-600">{desc}</p>
    </div>
  );
}

function CompareRow({ label, values }: { label: string; values: (boolean | string)[] }) {
  return (
    <tr>
      <td className="py-2.5 pr-4 text-gray-700">{label}</td>
      {values.map((v, i) => (
        <td key={i} className="px-4 py-2.5 text-center">
          {typeof v === 'boolean' ? (
            v ? (
              <svg aria-hidden="true" className="mx-auto h-5 w-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <span className="text-gray-300">—</span>
            )
          ) : (
            <span className="text-gray-600">{v}</span>
          )}
        </td>
      ))}
    </tr>
  );
}

function PricingFaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-200 py-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-4 text-left"
      >
        <h3 className="text-sm font-semibold text-gray-900">{question}</h3>
        <motion.svg
          className="h-4 w-4 shrink-0 text-gray-400"
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </motion.svg>
      </button>
      <div className={`grid transition-all duration-200 ${open ? 'mt-2 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
        <div className="overflow-hidden">
          <p className="text-sm leading-relaxed text-gray-600">{answer}</p>
        </div>
      </div>
    </div>
  );
}

function RoiCalculator({ country }: { country: CountryCode }) {
  const [bookingsPerDay, setBookingsPerDay] = useState(10);
  const [avgPrice, setAvgPrice] = useState(country === 'NG' ? 5000 : country === 'GH' ? 50 : 30);
  const tier: SubscriptionTier = bookingsPerDay <= 2 ? 'free' : bookingsPerDay <= 15 ? 'growth' : 'business';
  const tiers = getPricingTiers(country);
  const tierConfig = tiers[tier];
  const feePercent = tierConfig.feePercentage;
  const feeFlat = tierConfig.feeFlat;
  const subscriptionPrice = tierConfig.price as number;

  const monthlyBookings = bookingsPerDay * 26; // ~26 working days
  const monthlyRevenue = monthlyBookings * avgPrice;
  const platformFees = monthlyBookings * (avgPrice * feePercent / 100 + feeFlat);
  const netRevenue = monthlyRevenue - platformFees - subscriptionPrice;
  const roi = subscriptionPrice > 0 ? Math.round((netRevenue / (platformFees + subscriptionPrice)) * 100) : Math.round((netRevenue / Math.max(platformFees, 1)) * 100);

  // What they lose without Waaiio (assume 30% no-shows and missed messages)
  const missedRevenue = monthlyRevenue * 0.30;

  return (
    <div className="mt-8 rounded-2xl border border-gray-200 bg-gray-50 p-6">
      <div className="space-y-5">
        <div>
          <label className="flex items-center justify-between text-sm font-medium text-gray-700">
            <span>Bookings per day</span>
            <span className="text-lg font-bold text-brand">{bookingsPerDay}</span>
          </label>
          <input
            type="range"
            min={1}
            max={50}
            value={bookingsPerDay}
            onChange={(e) => setBookingsPerDay(Number(e.target.value))}
            className="mt-2 w-full accent-brand"
          />
          <div className="mt-1 flex justify-between text-xs text-gray-400">
            <span>1</span><span>25</span><span>50</span>
          </div>
        </div>

        <div>
          <label className="flex items-center justify-between text-sm font-medium text-gray-700">
            <span>Average price per booking</span>
            <span className="text-lg font-bold text-brand">{formatCurrency(avgPrice, country)}</span>
          </label>
          <input
            type="range"
            min={country === 'NG' ? 1000 : country === 'GH' ? 10 : 10}
            max={country === 'NG' ? 50000 : country === 'GH' ? 500 : 200}
            step={country === 'NG' ? 500 : country === 'GH' ? 5 : 5}
            value={avgPrice}
            onChange={(e) => setAvgPrice(Number(e.target.value))}
            className="mt-2 w-full accent-brand"
          />
        </div>
      </div>

      {/* Results */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-white p-4 text-center shadow-sm">
          <p className="text-xs text-gray-500">Monthly revenue</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCurrency(monthlyRevenue, country)}</p>
          <p className="text-xs text-gray-400">{monthlyBookings} bookings/mo</p>
        </div>
        <div className="rounded-xl bg-white p-4 text-center shadow-sm">
          <p className="text-xs text-gray-500">Waaiio cost</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCurrency(platformFees + subscriptionPrice, country)}</p>
          <p className="text-xs text-gray-400">{feePercent}% fee + {formatCurrency(subscriptionPrice, country)}/mo</p>
        </div>
        <div className="rounded-xl bg-green-50 p-4 text-center shadow-sm border border-green-100">
          <p className="text-xs text-green-600">You keep</p>
          <p className="mt-1 text-2xl font-bold text-green-700">{formatCurrency(netRevenue, country)}</p>
          <p className="text-xs text-green-500">{roi}x return on investment</p>
        </div>
        <div className="rounded-xl bg-red-50 p-4 text-center shadow-sm border border-red-100">
          <p className="text-xs text-red-500">Revenue lost without Waaiio</p>
          <p className="mt-1 text-2xl font-bold text-red-600">{formatCurrency(missedRevenue, country)}</p>
          <p className="text-xs text-red-400">~30% from no-shows &amp; missed messages</p>
        </div>
      </div>

      <p className="mt-4 text-center text-xs text-gray-400">
        Recommended plan: <span className="font-semibold text-brand">{tiers[tier].name}</span> ({formatCurrency(subscriptionPrice, country)}/mo)
      </p>
    </div>
  );
}
