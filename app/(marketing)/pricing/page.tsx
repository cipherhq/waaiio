'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { formatCurrency, getPricingTiers, type CountryCode, type SubscriptionTier } from '@/lib/constants';
import { loadCountries, getCountryList, type CountryRow } from '@/lib/countries';

export default function PricingPage() {
  const [country, setCountry] = useState<CountryCode>('NG');
  const [billingVolume, setBillingVolume] = useState(200);
  const [countryList, setCountryList] = useState<CountryRow[]>(getCountryList());
  const tiers = getPricingTiers(country);

  useEffect(() => {
    loadCountries().then(() => setCountryList(getCountryList()));
  }, []);

  const feeEstimates = {
    free: Math.round(billingVolume * (2.5 / 100) * 5000 + billingVolume * tiers.free.feeFlat),
    growth: Math.round(billingVolume * (1.5 / 100) * 5000 + billingVolume * tiers.growth.feeFlat),
    business: Math.round(billingVolume * (1.0 / 100) * 5000 + billingVolume * tiers.business.feeFlat),
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
            Start free with our 7-day trial. No credit card required. Pay only for what you use — or lock in a monthly plan for lower fees.
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
        <div className="mx-auto max-w-6xl px-4">
          <div className="grid gap-8 lg:grid-cols-3">
            <TierCard
              tier="free"
              name="Starter"
              price="Free"
              priceNote="No monthly fee"
              description="Perfect for trying out Waaiio with zero risk."
              features={[
                '7-day free trial (no fees at all)',
                'Up to 50 bookings/month',
                'WhatsApp automation',
                'Dashboard & analytics',
                `2.5% + ${formatCurrency(tiers.free.feeFlat, country)} per transaction`,
              ]}
              cta={{ label: 'Start Free Trial', href: '/get-started' }}
              country={country}
            />
            <TierCard
              tier="growth"
              name="Pro"
              price={formatCurrency(tiers.growth.price, country)}
              priceNote="/month"
              description="For growing businesses that need more volume and features."
              highlight
              features={[
                'Everything in Starter, plus:',
                'Up to 500 bookings/month',
                'WhatsApp reminders',
                'Recurring payments',
                'Broadcast messages',
                `1.5% + ${formatCurrency(tiers.growth.feeFlat, country)} per transaction`,
              ]}
              cta={{ label: 'Get Started', href: '/get-started?plan=growth', gold: true }}
              country={country}
            />
            <TierCard
              tier="business"
              name="Premium"
              price={formatCurrency(tiers.business.price, country)}
              priceNote="/month"
              description="For established businesses that want full control and branding."
              features={[
                'Everything in Pro, plus:',
                'Unlimited bookings',
                'Custom bot persona & greeting',
                'Loyalty & referral programs',
                'Queue & waitlist management',
                'Customer feedback & reviews',
                `1% + ${formatCurrency(tiers.business.feeFlat, country)} per transaction`,
              ]}
              cta={{ label: 'Get Started', href: '/get-started?plan=business' }}
              country={country}
            />
          </div>
        </div>
      </section>

      {/* Billing Calculator */}
      <section className="border-t border-gray-100 bg-gray-50 py-16">
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
              Assuming average transaction of {formatCurrency(5000, country)}
            </p>

            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              {([
                { tier: 'free' as SubscriptionTier, name: 'Starter', monthly: 0 },
                { tier: 'growth' as SubscriptionTier, name: 'Pro', monthly: tiers.growth.price },
                { tier: 'business' as SubscriptionTier, name: 'Premium', monthly: tiers.business.price },
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
                    <p className="text-xs text-gray-500">/month estimated total</p>
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
      </section>

      {/* How Messages Are Billed */}
      <section className="bg-white py-16">
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
              desc="Payments go directly to your Paystack or Stripe account. Platform fees are deducted automatically — no invoices to worry about."
            />
          </div>
        </div>
      </section>

      {/* Best for Business Feature Cards */}
      <section className="bg-gray-50 py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-2xl font-bold text-gray-900">
            Best for every business
          </h2>
          <p className="mt-2 text-center text-gray-600">
            Features that make Waaiio the go-to WhatsApp automation platform
          </p>

          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: '&#x1F4AC;', title: 'WhatsApp Native', desc: 'Customers interact on the app they use daily. No downloads, no links, no friction.' },
              { icon: '&#x1F3ED;', title: '35+ Industries', desc: 'Churches, mosques, salons, clinics, schools, shops, NGOs, events — pre-built flows for every category.' },
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
      </section>

      {/* Case Study */}
      <section className="bg-white py-16">
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
      </section>

      {/* Pricing FAQ */}
      <section className="bg-gray-50 py-16">
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
              question="What happens after my 7-day trial?"
              answer="After 7 days, the Starter plan's per-transaction fees kick in (2.5% + flat fee). Your bot keeps working — there's no interruption."
            />
            <PricingFaqItem
              question="Are there any hidden fees?"
              answer="No. You pay your plan subscription (if any) plus the per-transaction fees shown. Payment gateway fees (Paystack/Stripe) are separate and go directly to the gateway."
            />
            <PricingFaqItem
              question="Do I need a separate Paystack/Stripe account?"
              answer="Yes. During onboarding, we'll guide you to connect your Paystack (NG/GH) or Stripe (US/UK/CA) account so payments go directly to you."
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
      </section>

      {/* Final CTA */}
      <section className="bg-white py-16">
        <div className="mx-auto max-w-4xl px-4 text-center">
          <div className="rounded-3xl bg-gradient-to-br from-brand-900 via-brand to-brand-700 p-10 lg:p-14">
            <h2 className="text-2xl font-bold text-white lg:text-3xl">
              Start automating your business today
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-brand-200">
              7-day free trial. No credit card. No setup fees. No risk.
            </p>
            <Link
              href="/get-started"
              className="mt-6 inline-block rounded-xl bg-accent px-8 py-4 text-sm font-bold text-gray-900 shadow-lg shadow-accent/25 transition hover:bg-accent-400"
            >
              Get Started Free
            </Link>
          </div>
        </div>
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
    <div
      className={`relative flex flex-col rounded-2xl border p-8 ${
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

function PricingFaqItem({ question, answer }: { question: string; answer: string }) {
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
