'use client';

import React from 'react';
import {
  formatCurrency,
  type SubscriptionTier,
} from '@/lib/constants';
import { CATEGORY_DEFAULT_CAPABILITIES, CAPABILITY_TIER_REQUIREMENTS, type CapabilityId } from '@/lib/capabilities/types';
import type { StepFeaturesProps } from './types';

export function StepFeatures({
  selectedCapabilities,
  setSelectedCapabilities,
  selectedPlan,
  setSelectedPlan,
  selectedCountry,
  category,
  requiredPlan,
  localTiers,
  billingInterval,
  setStep,
}: StepFeaturesProps) {
  return (
    <div>
      <button type="button" onClick={() => setStep('category')} className="mb-4 flex items-center gap-1 text-sm text-gray-500 hover:text-brand">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        Back
      </button>
      <h2 className="text-2xl font-bold text-gray-900">What should your bot do?</h2>
      <p className="mt-1 text-sm text-gray-500">Pick the features you need. We&apos;ve pre-selected the most popular ones for your industry. You can always change this later in settings.</p>

      {/* Feature cards */}
      <div className="mt-6 space-y-3">
        {/* Customer-facing features */}
        {([
          {
            id: 'appointment' as CapabilityId,
            title: 'Book Appointments',
            desc: 'Customers pick a date, time, and staff member to book with you.',
            tip: 'Great for salons, barbers, clinics, consultants, gyms, and any business where customers need to reserve a specific time slot.',
            example: 'e.g. "Book a haircut for Saturday at 2pm with James"',
          },
          {
            id: 'ordering' as CapabilityId,
            title: 'Take Orders',
            desc: 'Customers browse your menu or catalog and place orders on WhatsApp.',
            tip: 'Perfect for restaurants, food delivery, shops, pharmacies, and anyone selling products. Includes cart, checkout, and order tracking.',
            example: 'e.g. "I\'d like 2 Jollof Rice and 1 Peppered Chicken"',
          },
          {
            id: 'table_reservation' as CapabilityId,
            title: 'Make Reservations',
            desc: 'Customers reserve tables or spots with date, time, and party size.',
            tip: 'For restaurants, cafes, bars, lounges, and any business where customers reserve a table or spot for dining.',
            example: 'e.g. "Reserve a table for 4 on Friday at 7pm"',
          },
          {
            id: 'reservation' as CapabilityId,
            title: 'Book Stays / Rentals',
            desc: 'Guests pick check-in and check-out dates to book your property.',
            tip: 'For hotels, Airbnb hosts, shortlets, car rentals, and any business that rents space or vehicles by the day/night.',
            example: 'e.g. "Book the Loft Suite from Dec 20-23"',
          },
          {
            id: 'ticketing' as CapabilityId,
            title: 'Sell Tickets',
            desc: 'Customers buy tickets to your events with QR code entry.',
            tip: 'For concerts, workshops, conferences, cinema, church events, comedy shows, and any ticketed event. Includes QR code generation for check-in.',
            example: 'e.g. "Buy 2 VIP tickets for the Jazz Night"',
          },
          {
            id: 'payment' as CapabilityId,
            title: 'Accept Payments',
            desc: 'Send payment links and collect money through WhatsApp.',
            tip: 'For any business that needs to collect payments without appointments or orders. Schools (fees), parking (charges), government (permits), etc.',
            example: 'e.g. "Pay your school fees" or "Pay parking fee"',
          },
          {
            id: 'giving' as CapabilityId,
            title: 'Collect Donations',
            desc: 'Accept tithes, offerings, and donations through WhatsApp.',
            tip: 'For churches, mosques, NGOs, and nonprofits. Supporters can give with one message. Tracks donors and amounts.',
            example: 'e.g. "Give tithe of N5,000" or "Donate to Building Fund"',
          },
          {
            id: 'scheduling' as CapabilityId,
            title: 'On-Demand Services',
            desc: 'Customers request services without choosing a specific time.',
            tip: 'For laundry, printing, repairs, cleaning, and services where you handle the scheduling. Customer just says what they need.',
            example: 'e.g. "I need 3 shirts washed and ironed"',
          },
          {
            id: 'crowdfunding' as CapabilityId,
            title: 'Run Campaigns',
            desc: 'Set fundraising goals and track donations in real time.',
            tip: 'For crowdfunding campaigns, building projects, emergency appeals. Shows progress toward goal and donor recognition.',
            example: 'e.g. "New Church Building Fund — N2M of N5M raised"',
          },
          {
            id: 'chat' as CapabilityId,
            title: 'Live Chat',
            desc: 'Let customers chat with your team directly on WhatsApp.',
            tip: 'Two-way messaging between your staff and customers. Handle questions, complaints, and custom requests. You can reply from your dashboard.',
            example: 'e.g. "Do you have this in size 42?"',
          },
          {
            id: 'invoice' as CapabilityId,
            title: 'Send Invoices',
            desc: 'Create professional invoices and send them via WhatsApp.',
            tip: 'For freelancers, contractors, mechanics, and service providers. Create invoices with line items and payment links. Customer pays in one click.',
            example: 'e.g. "Invoice #1042 — Plumbing repair: N15,000"',
          },
          {
            id: 'recurring' as CapabilityId,
            title: 'Subscriptions & Recurring',
            desc: 'Automatically charge customers weekly, monthly, or yearly.',
            tip: 'Perfect for gym memberships, monthly subscriptions, weekly services, church monthly giving, and any recurring charge. Customers can manage their own subscriptions.',
            example: 'e.g. "Your N5,000/month gym membership renews tomorrow"',
          },
          {
            id: 'broadcast' as CapabilityId,
            title: 'Broadcast Messages',
            desc: 'Send promotions and announcements to all your customers at once.',
            tip: 'Announce sales, new products, schedule changes, events, or holiday hours. Message all customers or specific groups. Great for marketing and re-engagement.',
            example: 'e.g. "Flash Sale! 50% off all haircuts this Friday only"',
          },
          {
            id: 'auto_reply' as CapabilityId,
            title: 'Auto-Reply & Business Hours',
            desc: 'Automatically reply when you\'re closed or busy.',
            tip: 'Set your opening hours and a custom away message. Customers who message outside hours get an instant reply telling them when you\'re open. No messages go unanswered.',
            example: 'e.g. "Thanks for reaching out! We\'re open Mon-Sat 9am-6pm"',
          },
          {
            id: 'membership' as CapabilityId,
            title: 'Membership Tiers',
            desc: 'Reward your best customers with automatic VIP tiers.',
            tip: 'Create Bronze/Silver/Gold tiers based on customer spending. Members get automatic discounts and bonus loyalty points. Tiers upgrade automatically — no manual work.',
            example: 'e.g. "Congrats! You\'ve been upgraded to Gold Member — 10% off everything"',
          },
          {
            id: 'whatsapp_sign' as CapabilityId,
            title: 'E-Signatures',
            desc: 'Send contracts and documents for digital signature via WhatsApp.',
            tip: 'For real estate, legal, freelancers, and any business that needs signed agreements. Customers review and sign directly from their phone.',
            example: 'e.g. "Please review and sign your service agreement"',
          },
          {
            id: 'survey' as CapabilityId,
            title: 'Surveys',
            desc: 'Create and send custom surveys to collect customer feedback.',
            tip: 'Build surveys with multiple question types (choice, rating, text, yes/no). Send via WhatsApp and track responses in your dashboard.',
            example: 'e.g. "How did you hear about us?" with multiple choice options',
          },
          {
            id: 'poll' as CapabilityId,
            title: 'Polls',
            desc: 'Create quick polls and let customers vote via WhatsApp.',
            tip: 'Great for churches, communities, and events. Ask a question, customers vote, see results live. Perfect for deciding event dates, menu items, etc.',
            example: 'e.g. "What time works best for Bible study? 5pm / 6pm / 7pm"',
          },
          {
            id: 'queue' as CapabilityId,
            title: 'Queue Management',
            desc: 'Walk-in customers check in and get notified when it\'s their turn.',
            tip: 'For clinics, barbers, government offices, and any walk-in business. Customers join the queue via WhatsApp and get a notification when their turn is next.',
            example: 'e.g. "You are #5 in line. Estimated wait: 15 minutes"',
          },
          {
            id: 'staff' as CapabilityId,
            title: 'Staff Management',
            desc: 'Assign team members to services and manage their schedules.',
            tip: 'For businesses with multiple staff. Assign services to specific people, set work schedules, auto-balance bookings. Customers can pick their preferred staff.',
            example: 'e.g. "Book with James (Barber) or Sarah (Stylist)"',
          },
        ] as const).map(feat => {
          const isSelected = selectedCapabilities.includes(feat.id);
          const tier = CAPABILITY_TIER_REQUIREMENTS[feat.id] || 'free';
          const tierLabel = tier === 'free' ? null : tier === 'growth' ? 'Pro' : 'Premium';
          const tierColor = tier === 'growth' ? 'bg-blue-100 text-blue-700' : tier === 'business' ? 'bg-brand-100 text-brand-700' : '';
          // Disable if capability requires a higher plan than selected
          const planOrder = ['free', 'growth', 'business'] as const;
          const capTierIdx = planOrder.indexOf(tier as typeof planOrder[number]);
          const selectedPlanIdx = planOrder.indexOf(selectedPlan);
          // During onboarding, all features are available (30-day trial unlocks everything)
          // Tier badge still shown so users know what they'll need after trial
          const isLocked = false;
          return (
            <div key={feat.id} className="group relative">
              <button
                type="button"
                onClick={() => {
                  if (isLocked) return;
                  setSelectedCapabilities(prev =>
                    prev.includes(feat.id)
                      ? prev.filter(c => c !== feat.id)
                      : [...prev, feat.id]
                  );
                }}
                className={`w-full rounded-xl border-2 p-4 text-left transition ${
                  isLocked
                    ? 'border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed'
                    : isSelected
                      ? 'border-brand bg-brand-50/50'
                      : 'border-gray-200 hover:border-gray-300 bg-white'
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Checkbox */}
                  <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition ${
                    isSelected ? 'border-brand bg-brand' : 'border-gray-300'
                  }`}>
                    {isSelected && (
                      <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900">{feat.title}</span>
                      {tierLabel && (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tierColor}`}>{tierLabel}</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500">{feat.desc}</p>
                    <p className="mt-1 text-[11px] text-gray-400 italic">{feat.example}</p>
                  </div>
                </div>
              </button>
              {/* Tooltip on hover */}
              <div className="pointer-events-none absolute left-0 right-0 -bottom-1 translate-y-full z-20 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                <div className="mx-4 rounded-lg bg-gray-900 px-3 py-2 text-xs text-white shadow-lg">
                  <p>{feat.tip}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Background features (auto-enabled, not shown to customer in bot) */}
      <div className="mt-6">
        <button
          type="button"
          onClick={() => {
            const el = document.getElementById('background-features');
            if (el) el.classList.toggle('hidden');
          }}
          className="flex items-center gap-2 text-xs font-medium text-gray-500 hover:text-gray-700"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
          Advanced: Background features
        </button>
        <div id="background-features" className="hidden mt-3 space-y-2">
          <p className="text-xs text-gray-400 mb-2">These work behind the scenes. Customers don&apos;t see them in the bot menu.</p>
          {([
            { id: 'feedback' as CapabilityId, title: 'Customer Reviews', desc: 'Automatically ask for ratings after a booking or order' },
            { id: 'loyalty' as CapabilityId, title: 'Loyalty Program', desc: 'Reward repeat customers with points' },
            { id: 'referral' as CapabilityId, title: 'Referral Program', desc: 'Let customers earn rewards for referring friends' },
            { id: 'reminders' as CapabilityId, title: 'Auto Reminders', desc: 'Send booking/payment reminders automatically' },
            { id: 'reports' as CapabilityId, title: 'Document Sharing', desc: 'Send documents to customers via WhatsApp' },
            { id: 'waitlist' as CapabilityId, title: 'Waitlist', desc: 'Automatically manage waitlists when fully booked' },
          ] as const).map(feat => {
            const isSelected = selectedCapabilities.includes(feat.id);
            const tier = CAPABILITY_TIER_REQUIREMENTS[feat.id] || 'free';
            const tierLabel = tier === 'free' ? null : tier === 'growth' ? 'Pro' : 'Premium';
            const tierColor = tier === 'growth' ? 'bg-blue-100 text-blue-700' : tier === 'business' ? 'bg-brand-100 text-brand-700' : '';
            return (
              <button
                key={feat.id}
                type="button"
                onClick={() => {
                  setSelectedCapabilities(prev =>
                    prev.includes(feat.id)
                      ? prev.filter(c => c !== feat.id)
                      : [...prev, feat.id]
                  );
                }}
                className={`w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${
                  isSelected ? 'border-brand/50 bg-brand-50/30' : 'border-gray-200 bg-white'
                }`}
              >
                <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                  isSelected ? 'border-brand bg-brand' : 'border-gray-300'
                }`}>
                  {isSelected && <svg className="h-2.5 w-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-700">{feat.title}</span>
                  {tierLabel && <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${tierColor}`}>{tierLabel}</span>}
                  <span className="text-[11px] text-gray-400">{feat.desc}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected count & plan indicator */}
      <div className="mt-6 rounded-xl bg-gray-50 border border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-gray-700">
              {selectedCapabilities.length} feature{selectedCapabilities.length !== 1 ? 's' : ''} selected
            </p>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {requiredPlan === 'free' ? (
                <span className="text-green-600 font-medium">Free plan — no monthly fee, {String(localTiers?.free?.feePercentage ?? 2)}% per transaction</span>
              ) : requiredPlan === 'growth' ? (
                billingInterval === 'year' ? (
                  <span className="text-blue-600 font-medium">Requires Pro plan — {String(formatCurrency(Math.round((Number(localTiers?.growth?.price) || 0) * 12 * 0.8), selectedCountry))}/year (save 20%), {String(localTiers?.growth?.feePercentage ?? 1.5)}% per transaction</span>
                ) : (
                  <span className="text-blue-600 font-medium">Requires Pro plan — {String(formatCurrency(Number(localTiers?.growth?.price) || 0, selectedCountry))}/mo, {String(localTiers?.growth?.feePercentage ?? 1.5)}% per transaction</span>
                )
              ) : (
                billingInterval === 'year' ? (
                  <span className="text-brand-600 font-medium">Requires Premium plan — {String(formatCurrency(Math.round((Number(localTiers?.business?.price) || 0) * 12 * 0.8), selectedCountry))}/year (save 20%), {String(localTiers?.business?.feePercentage ?? 1)}% per transaction</span>
                ) : (
                  <span className="text-brand-600 font-medium">Requires Premium plan — {String(formatCurrency(Number(localTiers?.business?.price) || 0, selectedCountry))}/mo, {String(localTiers?.business?.feePercentage ?? 1)}% per transaction</span>
                )
              )}
            </p>
          </div>
          {selectedCapabilities.length === 0 && (
            <button type="button" onClick={() => {
              const defaults = CATEGORY_DEFAULT_CAPABILITIES[category!] || ['chat'];
              setSelectedCapabilities([...defaults]);
            }} className="text-xs font-medium text-brand hover:underline">
              Reset to defaults
            </button>
          )}
        </div>
        <p className="text-[10px] text-gray-400 mt-1">You can always change this later in Dashboard &rarr; Settings</p>
      </div>

      <div className="mt-6">
        <p className="text-center text-xs text-gray-500 mb-3">All features included free for 30 days. No credit card required.</p>
        <button
          type="button"
          onClick={() => {
            // Auto-select plan based on features (for backend tier assignment)
            const planOrder = ['free', 'growth', 'business'] as const;
            const requiredIdx = planOrder.indexOf(requiredPlan);
            const currentIdx = planOrder.indexOf(selectedPlan);
            if (requiredIdx > currentIdx) {
              setSelectedPlan(requiredPlan as SubscriptionTier);
            }
            setStep('details');
          }}
          disabled={selectedCapabilities.length === 0}
          className="w-full rounded-xl bg-brand py-3.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
        >
          Start Free Trial
        </button>
        {selectedCapabilities.length === 0 && (
          <p className="text-center text-xs text-red-500 mt-2">Please select at least one feature to continue</p>
        )}
      </div>
    </div>
  );
}
