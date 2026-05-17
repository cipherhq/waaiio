'use client';

import { useState } from 'react';
import Link from 'next/link';

interface HelpArticle {
  category: string;
  question: string;
  answer: string;
}

const HELP_CATEGORIES = [
  { key: 'getting-started', label: 'Getting Started', icon: '\u{1F680}', description: 'Sign up, set up your bot, and start accepting customers' },
  { key: 'bookings', label: 'Bookings & Appointments', icon: '\u{1F4C5}', description: 'How booking, rescheduling, and cancellations work' },
  { key: 'payments', label: 'Payments & Payouts', icon: '\u{1F4B0}', description: 'Payment gateways, fees, and getting your money' },
  { key: 'whatsapp-bot', label: 'WhatsApp Bot', icon: '\u{1F916}', description: 'How the bot works, keywords, and live chat' },
  { key: 'account', label: 'Account & Billing', icon: '\u{2699}\u{FE0F}', description: 'Subscription, upgrades, and managing your account' },
];

const HELP_ARTICLES: HelpArticle[] = [
  // ── Getting Started ──
  {
    category: 'Getting Started',
    question: 'How do I get started?',
    answer: 'Sign up at waaiio.com/get-started, pick your industry, choose your features, and add your business details. It takes about 5 minutes. Your WhatsApp bot will be ready immediately.',
  },
  {
    category: 'Getting Started',
    question: 'What do I need to sign up?',
    answer: 'Just an email address and a phone number. That\'s it. You don\'t need a website, an app, or any technical knowledge. We handle everything for you.',
  },
  {
    category: 'Getting Started',
    question: 'How do I add my services?',
    answer: 'After signing up, go to Services in your dashboard. Click "Add Service", type the name (like "Haircut" or "Full Grooming"), set the price and how long it takes, then save. Your bot will start offering that service to customers right away.',
  },
  {
    category: 'Getting Started',
    question: 'How do I set my opening hours?',
    answer: 'Go to Settings in your dashboard. Scroll to "Operating Hours" and pick which days you\'re open. Set the start and end time for each day. The bot will only show time slots during your opening hours.',
  },
  {
    category: 'Getting Started',
    question: 'How do customers find my business?',
    answer: 'You get a unique WhatsApp link and QR code. Share the link on your social media (Instagram, Facebook, TikTok) or print the QR code and put it in your shop. When someone scans it or clicks the link, they land straight in a WhatsApp chat with your bot.',
  },
  {
    category: 'Getting Started',
    question: 'Can I try Waaiio before paying?',
    answer: 'Yes! Every plan starts with a 30-day free trial. During the trial, there are zero fees on any transaction. After 30 days, the fees for your chosen plan kick in. No credit card needed to start.',
  },

  // ── Bookings & Appointments ──
  {
    category: 'Bookings & Appointments',
    question: 'How do bookings work?',
    answer: 'A customer messages your WhatsApp number. The bot says hello, shows your services, and asks what they\'d like. The customer picks a service, chooses a date and time from available slots, and the booking is confirmed instantly. You see it in your dashboard.',
  },
  {
    category: 'Bookings & Appointments',
    question: 'Can customers reschedule their booking?',
    answer: 'Yes. A customer can type "reschedule" in the WhatsApp chat at any time. The bot will show their upcoming bookings and let them pick a new date and time. You\'ll be notified of the change.',
  },
  {
    category: 'Bookings & Appointments',
    question: 'How do cancellations work?',
    answer: 'Customers can type "cancel" in the chat to cancel a booking. You can also cancel from your dashboard by clicking on the booking and choosing "Cancel." Either way, the customer gets a WhatsApp message confirming the cancellation.',
  },
  {
    category: 'Bookings & Appointments',
    question: 'Does the bot send reminders?',
    answer: 'Yes! The bot automatically sends a reminder to the customer before their appointment (usually 24 hours and 1 hour before). This helps reduce no-shows by up to 60%.',
  },
  {
    category: 'Bookings & Appointments',
    question: 'What if someone books outside my working hours?',
    answer: 'The bot works 24/7, but it only shows time slots during your set operating hours. So a customer can message at 2 AM and book a slot for the next morning. The bot never sleeps, but it respects your schedule.',
  },
  {
    category: 'Bookings & Appointments',
    question: 'Can I block off times when I\'m unavailable?',
    answer: 'Yes. Go to your calendar in the dashboard and mark times as "Blocked." Those slots won\'t be offered to customers. Great for lunch breaks, personal appointments, or holidays.',
  },

  // ── Payments & Payouts ──
  {
    category: 'Payments & Payouts',
    question: 'How much does Waaiio cost?',
    answer: 'Waaiio has 3 plans: Starter (free, 2% per transaction), Pro (\u20A615,000/month, 1.5%), and Premium (\u20A650,000/month, 1%). All plans include a 30-day free trial with zero fees. You can also check our Pricing page for prices in your currency.',
  },
  {
    category: 'Payments & Payouts',
    question: 'How do I get paid?',
    answer: 'Add your bank details in Dashboard \u2192 Payouts. You can choose "Direct Split" (money goes to your bank after each transaction) or "Platform Managed" (we collect everything and send you a weekly payout every Monday). Free plan minimum payout is \u20A65,000.',
  },
  {
    category: 'Payments & Payouts',
    question: 'What payment methods can my customers use?',
    answer: 'In Nigeria and Ghana: bank transfer and card payments via Paystack. In the US: card, Apple Pay, Google Pay, and Cash App via Square or Stripe. In the UK and Canada: card payments via Stripe.',
  },
  {
    category: 'Payments & Payouts',
    question: 'Are there any hidden fees?',
    answer: 'No. You pay your plan subscription (if any) plus the per-transaction fee shown on the pricing page. Payment gateway fees (Paystack, Stripe, etc.) are separate and go directly to the payment provider.',
  },
  {
    category: 'Payments & Payouts',
    question: 'How long does it take to receive my money?',
    answer: 'With Direct Split mode: 1-3 business days after each transaction. With Platform Managed mode: weekly payouts every Monday. The exact timing depends on your payment gateway and bank.',
  },
  {
    category: 'Payments & Payouts',
    question: 'Can I collect tithes, offerings, or donations?',
    answer: 'Yes! Churches, mosques, NGOs, and other organisations can collect tithes, offerings, zakat, sadaqah, and donations through WhatsApp. Customers get a payment link in the chat, pay instantly, and receive a receipt.',
  },

  // ── WhatsApp Bot ──
  {
    category: 'WhatsApp Bot',
    question: 'How does the WhatsApp bot work?',
    answer: 'When someone messages your WhatsApp number, the bot reads the message, understands what they want (using AI), and responds automatically. It can show your services, take bookings, send payment links, process orders, answer questions, and more.',
  },
  {
    category: 'WhatsApp Bot',
    question: 'Can I customise what the bot says?',
    answer: 'Yes. Go to WhatsApp Bot in your dashboard. You can change the bot\'s name, greeting message, and personality. For example, you can make it formal, friendly, or even add a bit of humour. Business-tier users get full white-label branding.',
  },
  {
    category: 'WhatsApp Bot',
    question: 'What languages does the bot speak?',
    answer: 'The bot speaks English, Nigerian Pidgin, Yoruba, Igbo, Hausa, Twi, and French. It automatically detects the customer\'s language from their first message and responds in the same language.',
  },
  {
    category: 'WhatsApp Bot',
    question: 'What happens if the bot doesn\'t understand a message?',
    answer: 'If the bot can\'t figure out what someone means, it shows a simple menu with options the customer can tap. For tricky questions, it can hand over to you so you can reply directly from the Chat page in your dashboard.',
  },
  {
    category: 'WhatsApp Bot',
    question: 'Can I chat with customers directly?',
    answer: 'Yes! Go to Chat in your dashboard. You\'ll see all customer conversations. Click on one to read the messages and reply. While you\'re chatting, the bot pauses so you\'re in full control. When you\'re done, the bot takes over again.',
  },
  {
    category: 'WhatsApp Bot',
    question: 'What keywords can customers use?',
    answer: 'Customers can type natural messages like "I want to book" or "show me your prices." They can also use keywords like "book", "cancel", "reschedule", "menu", "order", "pay", "receipt", "help", or "hi" to start specific actions.',
  },

  // ── Account & Billing ──
  {
    category: 'Account & Billing',
    question: 'How do I upgrade my plan?',
    answer: 'Go to Settings in your dashboard, then the Account tab. Click "Upgrade" next to the plan you want. Complete the payment and your new features unlock immediately. No downtime.',
  },
  {
    category: 'Account & Billing',
    question: 'Can I downgrade or cancel anytime?',
    answer: 'Yes. There are no contracts or lock-in periods. Go to Settings \u2192 Account \u2192 click "Downgrade" or "Cancel." Your data stays safe even if you downgrade. You can always come back.',
  },
  {
    category: 'Account & Billing',
    question: 'How do I connect my own WhatsApp number?',
    answer: 'Available on Pro and Premium plans. Go to Settings and click "Connect with Facebook." You\'ll authorise Waaiio through your Facebook Business account, enter your phone number, and your number will be connected automatically.',
  },
  {
    category: 'Account & Billing',
    question: 'Is my data safe?',
    answer: 'Yes. We use bank-level encryption, your data is stored on secure servers, and we never share your information with third parties. We comply with GDPR and Nigerian data protection regulations (NDPR). You can read our full Privacy Policy for details.',
  },
  {
    category: 'Account & Billing',
    question: 'How do I delete my account?',
    answer: 'Go to Settings \u2192 Account \u2192 scroll to the bottom and click "Delete Account." This will permanently remove your business data, bookings, and customer information. This action cannot be undone, so make sure you\'re certain.',
  },
];

const CATEGORIES = [...new Set(HELP_ARTICLES.map(a => a.category))];

export default function HelpPage() {
  const [search, setSearch] = useState('');
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [selectedCategory, setSelectedCategory] = useState('');

  const filtered = HELP_ARTICLES.filter(a => {
    const q = search.toLowerCase();
    const matchesSearch = !search || a.question.toLowerCase().includes(q) || a.answer.toLowerCase().includes(q);
    const matchesCategory = !selectedCategory || a.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const grouped = new Map<string, { article: HelpArticle; index: number }[]>();
  filtered.forEach((article, i) => {
    const list = grouped.get(article.category) || [];
    list.push({ article, index: i });
    grouped.set(article.category, list);
  });

  return (
    <div className="min-h-screen bg-white">
      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-900 via-brand to-brand-700 py-24 lg:py-32">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-brand-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-[400px] w-[400px] rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-3xl px-4 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-sm font-medium text-white backdrop-blur">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
            </span>
            Help Center
          </span>
          <h1 className="mt-6 text-4xl font-extrabold text-white sm:text-5xl">
            How can we help you?
          </h1>
          <p className="mt-4 text-lg text-brand-200">
            Find answers to common questions about Waaiio. Everything is written so anyone can understand.
          </p>

          {/* Search */}
          <div className="mx-auto mt-8 max-w-xl">
            <div className="relative">
              <svg className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search for answers..."
                className="w-full rounded-2xl border-0 bg-white py-4 pl-12 pr-4 text-sm text-gray-900 shadow-xl outline-none ring-2 ring-white/20 placeholder:text-gray-400 focus:ring-accent"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Category pills */}
      <section className="border-b border-gray-100 bg-gray-50 py-6">
        <div className="mx-auto max-w-5xl px-4">
          <div className="flex flex-wrap justify-center gap-2">
            <button
              onClick={() => setSelectedCategory('')}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                !selectedCategory
                  ? 'bg-brand text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
              }`}
            >
              All Topics
            </button>
            {HELP_CATEGORIES.map(cat => (
              <button
                key={cat.key}
                onClick={() => setSelectedCategory(cat.label)}
                className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                  selectedCategory === cat.label
                    ? 'bg-brand text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
                }`}
              >
                <span className="mr-1.5">{cat.icon}</span>
                {cat.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Category overview cards (when no search/filter active) */}
      {!search && !selectedCategory && (
        <section className="bg-white py-16">
          <div className="mx-auto max-w-5xl px-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {HELP_CATEGORIES.map(cat => {
                const count = HELP_ARTICLES.filter(a => a.category === cat.label).length;
                return (
                  <button
                    key={cat.key}
                    onClick={() => setSelectedCategory(cat.label)}
                    className="group rounded-2xl border border-gray-200 bg-white p-6 text-left transition hover:border-brand-200 hover:shadow-lg"
                  >
                    <span className="text-3xl">{cat.icon}</span>
                    <h3 className="mt-3 text-base font-semibold text-gray-900 group-hover:text-brand">{cat.label}</h3>
                    <p className="mt-1 text-sm text-gray-500">{cat.description}</p>
                    <p className="mt-3 text-xs font-medium text-brand">{count} articles</p>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* FAQ accordion */}
      <section className="bg-white py-12 pb-20">
        <div className="mx-auto max-w-3xl px-4">
          {Array.from(grouped.entries()).map(([cat, items]) => (
            <div key={cat} className="mb-10">
              <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900">
                <span>{HELP_CATEGORIES.find(c => c.label === cat)?.icon}</span>
                {cat}
              </h2>
              <div className="mt-4 divide-y divide-gray-100 rounded-2xl border border-gray-200 bg-white overflow-hidden">
                {items.map(({ article, index }) => (
                  <div key={index}>
                    <button
                      onClick={() => setOpenIndex(openIndex === index ? null : index)}
                      className="flex w-full items-center justify-between px-6 py-5 text-left transition hover:bg-gray-50"
                    >
                      <span className="pr-4 text-sm font-medium text-gray-900">{article.question}</span>
                      <svg
                        className={`h-5 w-5 flex-shrink-0 text-gray-400 transition-transform duration-200 ${openIndex === index ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {openIndex === index && (
                      <div className="border-t border-gray-100 bg-gray-50 px-6 py-5">
                        <p className="text-sm leading-relaxed text-gray-600">{article.answer}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="rounded-2xl border border-gray-200 bg-white py-16 text-center">
              <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <h3 className="mt-4 text-base font-semibold text-gray-900">No results found</h3>
              <p className="mt-1 text-sm text-gray-500">Try a different search term or browse by category.</p>
              <button
                onClick={() => { setSearch(''); setSelectedCategory(''); }}
                className="mt-4 text-sm font-medium text-brand hover:underline"
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Still need help? */}
      <section className="bg-gray-50 py-16">
        <div className="mx-auto max-w-3xl px-4 text-center">
          <h2 className="text-2xl font-bold text-gray-900">Still need help?</h2>
          <p className="mt-2 text-gray-600">
            Can&apos;t find what you&apos;re looking for? Chat with us directly on WhatsApp. We typically respond within a few minutes during business hours.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <a
              href="https://wa.me/2349060009740?text=Hi%2C%20I%20need%20help%20with%20Waaiio"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-[#25D366] px-6 py-3 text-sm font-bold text-white shadow-lg transition hover:bg-[#1ebe5d]"
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
              </svg>
              Chat with us on WhatsApp
            </a>
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-6 py-3 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              Email Us
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
