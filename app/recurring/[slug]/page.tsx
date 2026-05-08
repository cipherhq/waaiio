'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface Business {
  id: string;
  name: string;
  slug: string;
  category: string;
  country_code: string;
  recurring_enabled: boolean;
}

interface Service {
  id: string;
  name: string;
}

export default function RecurringSetupPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const slug = params.slug as string;

  const [business, setBusiness] = useState<Business | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const [selectedService, setSelectedService] = useState(searchParams.get('service') || '');
  const [amount, setAmount] = useState(searchParams.get('amount') || '');
  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('monthly');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  useEffect(() => {
    async function load() {
      const supabase = createClient();

      const { data: biz } = await supabase
        .from('businesses')
        .select('id, name, slug, category, country_code, recurring_enabled')
        .eq('slug', slug)
        .single();

      if (!biz || !biz.recurring_enabled) {
        setLoading(false);
        return;
      }

      setBusiness(biz);

      const { data: svcs } = await supabase
        .from('services')
        .select('id, name')
        .eq('business_id', biz.id)
        .eq('is_active', true)
        .order('sort_order');

      setServices(svcs || []);
      setLoading(false);
    }
    load();
  }, [slug]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!business || !selectedService || !amount || !name || !email || !phone) {
      setError('Please fill in all fields.');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      const response = await fetch('/api/recurring/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          serviceId: selectedService,
          amount: parseFloat(amount),
          frequency,
          customerName: name,
          customerEmail: email,
          customerPhone: phone,
          channel: 'web',
        }),
      });

      const result = await response.json();

      if (result.url) {
        // Redirect to payment gateway
        window.location.href = result.url;
        return;
      }

      if (result.success) {
        setSuccess(true);
      } else {
        setError(result.error || 'Something went wrong. Please try again.');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  if (!business) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <h1 className="text-xl font-bold text-gray-900">Not Found</h1>
          <p className="mt-2 text-gray-500">This business doesn't support recurring payments.</p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <svg className="h-8 w-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="mt-4 text-xl font-bold text-gray-900">Recurring Payment Set Up!</h2>
          <p className="mt-2 text-sm text-gray-500">
            Your {frequency} payment has been configured. You'll be charged automatically.
          </p>
        </div>
      </div>
    );
  }

  const cc = business.country_code || 'NG';
  const currencySymbol = cc === 'NG' ? '\u20a6' : cc === 'GH' ? 'GH\u20b5' : cc === 'GB' ? '\u00a3' : '$';

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="mx-auto max-w-md">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600 text-xl font-bold text-white">
            {business.name.charAt(0)}
          </div>
          <h1 className="mt-3 text-xl font-bold text-gray-900">{business.name}</h1>
          <p className="mt-1 text-sm text-gray-500">Set up recurring payments</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4 rounded-2xl bg-white p-6 shadow-sm">
          {/* Service selection */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Service</label>
            <select
              value={selectedService}
              onChange={(e) => setSelectedService(e.target.value)}
              required
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
            >
              <option value="">Select a service...</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          {/* Amount */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Amount ({currencySymbol})</label>
            <input
              type="number"
              min="1"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              placeholder="e.g. 5000"
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
            />
          </div>

          {/* Frequency */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Frequency</label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setFrequency('monthly')}
                className={`flex-1 rounded-lg border-2 py-2.5 text-sm font-medium transition ${
                  frequency === 'monthly' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600'
                }`}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setFrequency('weekly')}
                className={`flex-1 rounded-lg border-2 py-2.5 text-sm font-medium transition ${
                  frequency === 'weekly' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600'
                }`}
              >
                Weekly
              </button>
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Full Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="John Doe"
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
            />
          </div>

          {/* Email */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="john@example.com"
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
            />
          </div>

          {/* Phone */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">WhatsApp Number</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              placeholder="Phone number"
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Setting up...' : `Set Up ${frequency === 'weekly' ? 'Weekly' : 'Monthly'} Payment`}
          </button>

          <p className="text-center text-xs text-gray-400">
            You'll be redirected to securely set up your payment method
          </p>
        </form>
      </div>
    </div>
  );
}
