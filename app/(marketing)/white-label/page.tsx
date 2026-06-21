import type { Metadata } from 'next';
import AnimatedSection from '@/components/marketing/AnimatedSection';
import DemoForm from './DemoForm';

export const metadata: Metadata = {
  title: 'White Label — Waaiio',
  description:
    'White-label WhatsApp automation for your brand. Bring your WhatsApp Business account and your customers — we power the automation, under your brand.',
  openGraph: {
    title: 'White Label WhatsApp Automation — Waaiio',
    description:
      'Branded dashboard, your domain, your verified WhatsApp number. We handle the engine and support.',
  },
};

/* ─── Feature cards ─── */
const FEATURES = [
  {
    title: 'Broadcasts & Campaigns',
    desc: 'Send targeted messages, promotions, and announcements to your entire customer base — with scheduling, segmentation, and delivery tracking.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 01-1.44-4.282m3.102.069a18.03 18.03 0 01-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 018.835 2.535M10.34 6.66a23.847 23.847 0 008.835-2.535m0 0A23.74 23.74 0 0018.795 3m.38 1.125a23.91 23.91 0 011.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 001.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 010 3.46" />
      </svg>
    ),
    color: 'border-amber-200 bg-amber-50/40',
    iconColor: 'text-amber-600',
  },
  {
    title: 'Reservations & Bookings',
    desc: 'Appointments, table reservations, scheduling, and event ticketing — all managed through WhatsApp conversations with real-time availability.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
      </svg>
    ),
    color: 'border-brand-200 bg-brand-50/40',
    iconColor: 'text-brand',
  },
  {
    title: 'Automated Reminders',
    desc: 'Reduce no-shows and missed payments with automated WhatsApp reminders — appointment confirmations, payment due dates, and follow-ups.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
      </svg>
    ),
    color: 'border-green-200 bg-green-50/40',
    iconColor: 'text-green-600',
  },
  {
    title: 'Multi-Location Support',
    desc: 'Manage multiple branches, locations, or franchise outlets from a single dashboard — each with its own services, staff, and availability.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
      </svg>
    ),
    color: 'border-blue-200 bg-blue-50/40',
    iconColor: 'text-blue-600',
  },
  {
    title: 'Loyalty & Referrals',
    desc: 'Built-in loyalty points, referral codes, and reward programs that run entirely inside WhatsApp — driving repeat visits and word-of-mouth growth.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
      </svg>
    ),
    color: 'border-rose-200 bg-rose-50/40',
    iconColor: 'text-rose-600',
  },
  {
    title: 'Branded Management Dashboard',
    desc: 'Your logo, your colors, your domain — a complete management dashboard your team uses daily, fully branded to your business identity.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" />
      </svg>
    ),
    color: 'border-purple-200 bg-purple-50/40',
    iconColor: 'text-purple-600',
  },
];

/* ─── How it works steps ─── */
const STEPS = [
  {
    num: '01',
    title: 'Your Brand, Your Dashboard',
    desc: 'We set up a fully branded management dashboard on your custom domain — your logo, your colors, your identity. Your team logs into your platform, not ours.',
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" />
      </svg>
    ),
  },
  {
    num: '02',
    title: 'Your Customers, Your WhatsApp',
    desc: 'Your customers interact with your verified WhatsApp Business number — not ours. They see your business name, your profile picture, your verified badge.',
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
      </svg>
    ),
  },
  {
    num: '03',
    title: 'We Handle the Engine',
    desc: 'The automation, infrastructure, updates, and technical support are all on us. You focus on your business and your customers — we keep the engine running.',
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.1-3.06a1.5 1.5 0 010-2.58l5.1-3.06a1.5 1.5 0 011.639.025l4.864 3.213a1.5 1.5 0 010 2.524l-4.864 3.213a1.5 1.5 0 01-1.639.025zM12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z" />
      </svg>
    ),
  },
];

/* ─── Target verticals ─── */
const VERTICALS = ['Concierge', 'Hospitality', 'Travel', 'Entertainment', 'Events', 'Memberships'];

export default function WhiteLabelPage() {
  return (
    <main className="overflow-x-clip">
      {/* ── Hero ── */}
      <section className="relative bg-gradient-to-br from-brand-900 via-brand to-brand-700 pb-20 pt-32 text-white lg:pb-28 lg:pt-40">
        {/* Decorative blobs */}
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -right-32 bottom-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />

        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <AnimatedSection>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-xs font-medium backdrop-blur-sm">
              <svg className="h-4 w-4 text-whatsapp" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
              </svg>
              White-Label WhatsApp Automation
            </span>
          </AnimatedSection>

          <AnimatedSection delay={0.1}>
            <h1 className="mx-auto mt-6 max-w-4xl text-4xl font-extrabold leading-tight sm:text-5xl lg:text-6xl">
              Bring your WhatsApp Business account and your customers —{' '}
              <span className="text-accent">we power the automation, under your brand.</span>
            </h1>
          </AnimatedSection>

          <AnimatedSection delay={0.2}>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-white/80">
              Purpose-built for{' '}
              {VERTICALS.map((v, i) => (
                <span key={v}>
                  {i > 0 && (i === VERTICALS.length - 1 ? ', and ' : ', ')}
                  <span className="font-medium text-white">{v.toLowerCase()}</span>
                </span>
              ))}
              {' '}businesses that need WhatsApp automation at scale — without building it themselves.
            </p>
          </AnimatedSection>

          <AnimatedSection delay={0.3}>
            <a
              href="#demo"
              className="mt-8 inline-flex rounded-xl bg-accent px-8 py-3.5 text-base font-bold text-gray-900 shadow-lg shadow-accent/20 transition hover:bg-accent-400 hover:shadow-xl"
            >
              Book a Demo
            </a>
          </AnimatedSection>
        </div>
      </section>

      {/* ── Feature Highlights ── */}
      <section className="bg-white py-20 lg:py-24">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection>
            <div className="text-center">
              <h2 className="text-3xl font-bold text-gray-900 lg:text-4xl">
                Everything your customers need, on WhatsApp
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-gray-600">
                Your white-label platform ships with the full Waaiio feature set — built to handle
                real businesses, real payments, and real customer conversations.
              </p>
            </div>
          </AnimatedSection>

          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <AnimatedSection key={f.title} delay={i * 0.08}>
                <div
                  className={`rounded-2xl border p-6 transition hover:shadow-lg ${f.color}`}
                >
                  <div className={`flex h-10 w-10 items-center justify-center rounded-lg bg-white shadow-sm ${f.iconColor}`}>
                    {f.icon}
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-gray-900">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-600">{f.desc}</p>
                </div>
              </AnimatedSection>
            ))}
          </div>
        </div>
      </section>

      {/* ── How White-Label Works ── */}
      <section className="bg-gray-50 py-20 lg:py-24">
        <div className="mx-auto max-w-6xl px-4">
          <AnimatedSection>
            <div className="text-center">
              <h2 className="text-3xl font-bold text-gray-900 lg:text-4xl">How it works</h2>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-gray-600">
                Three layers, clearly separated. Your brand stays front and center — we stay invisible.
              </p>
            </div>
          </AnimatedSection>

          <div className="mt-14 grid gap-8 lg:grid-cols-3">
            {STEPS.map((s, i) => (
              <AnimatedSection key={s.num} delay={i * 0.12}>
                <div className="relative rounded-2xl border border-gray-200 bg-white p-8 transition hover:shadow-lg">
                  <span className="text-4xl font-extrabold text-brand-100">{s.num}</span>
                  <div className="mt-3 flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand">
                      {s.icon}
                    </div>
                    <h3 className="text-lg font-semibold text-gray-900">{s.title}</h3>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-gray-600">{s.desc}</p>
                </div>
              </AnimatedSection>
            ))}
          </div>
        </div>
      </section>

      {/* ── Demo Request Form ── */}
      <section id="demo" className="scroll-mt-20 bg-white py-20 lg:py-24">
        <div className="mx-auto max-w-6xl px-4">
          <div className="mx-auto max-w-2xl">
            <AnimatedSection>
              <div className="text-center">
                <h2 className="text-3xl font-bold text-gray-900 lg:text-4xl">Book a Demo</h2>
                <p className="mt-4 text-base leading-relaxed text-gray-600">
                  Tell us about your business and we&apos;ll walk you through how white-label works —
                  tailored to your industry and scale.
                </p>
              </div>
            </AnimatedSection>

            <AnimatedSection delay={0.1}>
              <div className="mt-10 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
                <DemoForm />
              </div>
            </AnimatedSection>
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-20 text-white lg:py-24">
        <div className="relative mx-auto max-w-6xl px-4 text-center">
          <div className="pointer-events-none absolute -left-32 top-0 h-[300px] w-[300px] rounded-full bg-brand-400/15 blur-3xl" />
          <AnimatedSection>
            <h2 className="mx-auto max-w-3xl text-3xl font-bold lg:text-4xl">
              Your brand. Your customers. Our engine.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-white/80">
              Stop building WhatsApp automation from scratch. Launch your branded platform in weeks, not months.
            </p>
            <a
              href="#demo"
              className="mt-8 inline-flex rounded-xl bg-accent px-8 py-3.5 text-base font-bold text-gray-900 shadow-lg shadow-accent/20 transition hover:bg-accent-400 hover:shadow-xl"
            >
              Book a Demo
            </a>
          </AnimatedSection>
        </div>
      </section>
    </main>
  );
}
