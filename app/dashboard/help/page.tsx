'use client';

import { useState } from 'react';
import Link from 'next/link';

interface HelpArticle {
  category: string;
  question: string;
  answer: string;
  link?: string;
}

const HELP_ARTICLES: HelpArticle[] = [
  // Getting Started
  { category: 'Getting Started', question: 'How do I add my first service?', answer: 'Go to Services in the sidebar → Click "Add Service" → Enter the service name, price, and duration → Save. Your bot will immediately start offering this service to customers.' },
  { category: 'Getting Started', question: 'How do I set my operating hours?', answer: 'Go to Settings → Scroll to "Operating Hours" → Toggle the days you\'re open and set start/end times for each day → Save. The bot will only offer time slots during your operating hours.' },
  { category: 'Getting Started', question: 'How do I share my WhatsApp link?', answer: 'Go to QR Code & Link in the sidebar. You\'ll see your unique WhatsApp link and QR code. Copy the link to share on social media, or print the QR code for your shop.', link: '/dashboard/qr-code' },
  { category: 'Getting Started', question: 'How do customers find my business?', answer: 'Customers can message your bot code (e.g. "KINGS-CUTS") to the Waaiio WhatsApp number. You can also share your direct WhatsApp link from the QR Code & Link page.' },

  // Bookings & Orders
  { category: 'Bookings & Orders', question: 'How do bookings work?', answer: 'When a customer messages your WhatsApp number, the bot shows your services and available times. The customer selects a service, picks a time, and the booking is automatically confirmed. You\'ll see it in your Bookings dashboard.' },
  { category: 'Bookings & Orders', question: 'How do I handle cancellations?', answer: 'Go to Bookings → Find the booking → Click on it → Click "Cancel." The customer will be notified via WhatsApp. Customers can also type "cancel" in the WhatsApp chat to cancel their own bookings.' },
  { category: 'Bookings & Orders', question: 'Can customers reschedule?', answer: 'Yes! Customers can type "reschedule" in the WhatsApp chat to change their booking time. They\'ll see their upcoming bookings and can pick a new time slot.' },
  { category: 'Bookings & Orders', question: 'How do orders work for shops/restaurants?', answer: 'The bot shows your product catalog. Customers add items to their cart, confirm the order, and receive a payment link. Once paid, you\'ll see the order in your Orders dashboard.' },

  // Payments
  { category: 'Payments', question: 'How do I receive payments?', answer: 'Go to Payouts → Accept the terms → Choose "Connect with Stripe" (US/UK/CA) or add your bank details (Nigeria/Ghana). Once connected, customer payments are automatically split — you receive your share, Waaiio takes the platform fee.' },
  { category: 'Payments', question: 'What are the fees?', answer: 'Starter: 2.5% per transaction. Pro: 1.5% + monthly subscription. Premium: 1.5% + ₦75 per transaction + monthly subscription. All plans include a 30-day free trial with zero fees. Check the Pricing page for details.', link: '/pricing' },
  { category: 'Payments', question: 'When do I get paid?', answer: 'Depends on your payout mode. Direct split: payments arrive in your account within 1-3 business days. Platform managed: weekly payouts every Monday.' },
  { category: 'Payments', question: 'What payment methods do customers have?', answer: 'Nigeria/Ghana: Bank transfer, card via Paystack. US: Card, CashApp, Apple Pay, Google Pay via Square/Stripe. UK/Canada: Card via Stripe.' },

  // WhatsApp Bot
  { category: 'WhatsApp Bot', question: 'How do I customize my bot greeting?', answer: 'Go to WhatsApp Bot in the sidebar → Edit the greeting message and assistant name → Save. You can also set welcome buttons that appear when customers first message.' },
  { category: 'WhatsApp Bot', question: 'Can my bot speak multiple languages?', answer: 'Yes! The bot auto-detects the customer\'s language from their first message and responds accordingly. Supported languages: English, Nigerian Pidgin, Yoruba, Igbo, Hausa, Twi, and French.' },
  { category: 'WhatsApp Bot', question: 'What does the bot do when it doesn\'t understand?', answer: 'If the bot can\'t understand a message, it shows a menu of options the customer can choose from. For complex questions, it can escalate to live chat where you respond manually from the Chat dashboard.' },
  { category: 'WhatsApp Bot', question: 'Can I chat with customers directly?', answer: 'Yes! Go to Chat in the sidebar. You\'ll see all customer conversations. Click on a conversation to read messages and reply directly. The bot pauses while you\'re chatting.', link: '/dashboard/chat' },

  // Account & Billing
  { category: 'Account & Billing', question: 'How do I upgrade my plan?', answer: 'Go to Settings → Account tab → Click "Upgrade" next to the plan you want. You\'ll be redirected to complete payment. New capabilities are unlocked immediately.' },
  { category: 'Account & Billing', question: 'Can I downgrade or cancel?', answer: 'Yes. Go to Settings → Account tab → Click "Downgrade." You\'ll keep your data but lose access to higher-tier capabilities. There are no contracts — cancel anytime.' },
  { category: 'Account & Billing', question: 'How do I connect my own WhatsApp number?', answer: 'Available on Pro and Premium plans. Go to the onboarding flow or Settings → Click "Connect with Facebook" → Authorize Waaiio → Enter your phone number. Your number will be connected automatically.' },
];

const CATEGORIES = [...new Set(HELP_ARTICLES.map(a => a.category))];

export default function HelpPage() {
  const [search, setSearch] = useState('');
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [selectedCategory, setSelectedCategory] = useState('');

  const filtered = HELP_ARTICLES.filter(a => {
    const matchesSearch = !search || a.question.toLowerCase().includes(search.toLowerCase()) || a.answer.toLowerCase().includes(search.toLowerCase());
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
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Help Center</h1>
          <p className="mt-1 text-sm text-gray-500">Find answers to common questions</p>
        </div>
        <Link
          href="/dashboard/support"
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
        >
          Contact Support
        </Link>
      </div>

      {/* Search */}
      <div className="mt-6 flex gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search help articles..."
          className="flex-1 rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
          className="rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        >
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Articles */}
      <div className="mt-6 space-y-6">
        {Array.from(grouped.entries()).map(([cat, items]) => (
          <div key={cat}>
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">{cat}</h2>
            <div className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800">
              {items.map(({ article, index }) => (
                <div key={index}>
                  <button
                    onClick={() => setOpenIndex(openIndex === index ? null : index)}
                    className="flex w-full items-center justify-between px-5 py-4 text-left transition hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{article.question}</span>
                    <svg
                      className={`h-4 w-4 flex-shrink-0 text-gray-400 transition ${openIndex === index ? 'rotate-180' : ''}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {openIndex === index && (
                    <div className="border-t border-gray-100 bg-gray-50 px-5 py-4 dark:border-gray-700 dark:bg-gray-900">
                      <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{article.answer}</p>
                      {article.link && (
                        <Link href={article.link} className="mt-2 inline-block text-sm font-medium text-brand hover:underline">
                          Go to {article.link.replace('/dashboard/', '')} →
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="rounded-xl border border-gray-200 bg-white py-12 text-center dark:border-gray-700 dark:bg-gray-800">
            <p className="text-gray-500">No articles found. Try a different search.</p>
            <Link href="/dashboard/support" className="mt-2 inline-block text-sm font-medium text-brand hover:underline">
              Contact support instead →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
