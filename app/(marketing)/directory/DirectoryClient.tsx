'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { formatCurrency, type CountryCode } from '@/lib/constants';

interface Service {
  id: string;
  name: string;
  price: number;
  duration_minutes: number | null;
}

interface Business {
  id: string;
  name: string;
  category: string;
  country_code: CountryCode;
  city: string;
  address: string;
  bot_code: string;
  wa_method: string;
  slug: string;
  services: Service[];
  capabilities: string[];
}

const COUNTRIES = [
  { code: '', label: 'All Countries', flag: '🌍' },
  { code: 'NG', label: 'Nigeria', flag: '🇳🇬' },
  { code: 'US', label: 'United States', flag: '🇺🇸' },
  { code: 'GB', label: 'United Kingdom', flag: '🇬🇧' },
  { code: 'CA', label: 'Canada', flag: '🇨🇦' },
  { code: 'GH', label: 'Ghana', flag: '🇬🇭' },
];

const CATEGORIES = [
  { key: '', label: 'All Categories' },
  { key: 'barber', label: 'Barbers' },
  { key: 'salon', label: 'Salons' },
  { key: 'spa', label: 'Spas' },
  { key: 'restaurant', label: 'Restaurants' },
  { key: 'church', label: 'Churches' },
  { key: 'mosque', label: 'Mosques' },
  { key: 'shop', label: 'Shops' },
  { key: 'clinic', label: 'Clinics' },
  { key: 'hotel', label: 'Hotels' },
  { key: 'gym', label: 'Gyms' },
  { key: 'events', label: 'Events' },
  { key: 'food_delivery', label: 'Food Delivery' },
];

const CATEGORY_ICONS: Record<string, string> = {
  barber: '💈', salon: '💅', spa: '🧖', restaurant: '🍽️', church: '⛪',
  mosque: '🕌', shop: '🛍️', clinic: '🏥', hotel: '🏨', gym: '💪',
  events: '🎪', food_delivery: '🚚', school: '🎓', ngo: '❤️',
  tattoo: '🎨', dental: '🦷', veterinary: '🐾', pharmacy: '💊',
  cinema: '🎬', car_wash: '🚗', laundry: '👔', tutor: '📚',
  photographer: '📸', real_estate: '🏠', coworking: '💻', catering: '🍳',
};

const CAPABILITY_LABELS: Record<string, string> = {
  scheduling: 'Bookings', payment: 'Payments', ordering: 'Online Orders',
  ticketing: 'Tickets', feedback: 'Reviews', loyalty: 'Loyalty',
  chat: 'Live Chat', queue: 'Queue', waitlist: 'Waitlist',
  whatsapp_sign: 'E-Sign', invoice: 'Invoices', referral: 'Referrals',
  reminders: 'Reminders', reports: 'Reports', staff: 'Staff',
};

const WHATSAPP_NUMBERS: Record<string, string> = {
  NG: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_NG || '12029226251',
  US: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_US || '12029226251',
  GB: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_GB || '12029226251',
  CA: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_CA || '12029226251',
  GH: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_GH || '12029226251',
};

export default function DirectoryClient() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);
  const [country, setCountry] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input by 300ms
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const params = new URLSearchParams();
      if (country) params.set('country', country);
      if (category) params.set('category', category);
      if (debouncedSearch) params.set('search', debouncedSearch);

      const res = await fetch(`/api/directory?${params}`);
      const data = await res.json();
      setBusinesses(data.businesses || []);
      setLoading(false);
    }
    load();
  }, [country, category, debouncedSearch]);

  // Group by country
  const grouped = new Map<string, Business[]>();
  for (const biz of businesses) {
    const key = biz.country_code || 'OTHER';
    const list = grouped.get(key) || [];
    list.push(biz);
    grouped.set(key, list);
  }

  const countryName = (code: string) => COUNTRIES.find(c => c.code === code)?.label || code;
  const countryFlag = (code: string) => COUNTRIES.find(c => c.code === code)?.flag || '🌍';

  return (
    <div className="min-h-screen bg-gray-50 pt-24 pb-16">
      <div className="mx-auto max-w-6xl px-4">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900 sm:text-4xl">Business Directory</h1>
          <p className="mt-2 text-gray-600">
            Discover businesses powered by Waaiio. Message them directly on WhatsApp.
          </p>
        </div>

        {/* Filters */}
        <div className="mt-8 flex flex-wrap gap-3">
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm focus:border-brand focus:ring-2 focus:ring-brand-100"
          >
            {COUNTRIES.map(c => (
              <option key={c.code} value={c.code}>{c.flag} {c.label}</option>
            ))}
          </select>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm focus:border-brand focus:ring-2 focus:ring-brand-100"
          >
            {CATEGORIES.map(c => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search businesses..."
            className="flex-1 min-w-[200px] rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm focus:border-brand focus:ring-2 focus:ring-brand-100"
          />
        </div>

        {/* Results */}
        {loading ? (
          <div className="mt-12 flex justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
          </div>
        ) : businesses.length === 0 ? (
          <div className="mt-12 rounded-2xl border border-gray-200 bg-white py-16 text-center">
            <p className="text-lg text-gray-500">No businesses found</p>
            <p className="mt-1 text-sm text-gray-400">Try a different country or category</p>
          </div>
        ) : (
          <div className="mt-8 space-y-8">
            {Array.from(grouped.entries()).map(([countryCode, bizList]) => (
              <div key={countryCode}>
                <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900">
                  <span className="text-2xl">{countryFlag(countryCode)}</span>
                  {countryName(countryCode)}
                  <span className="ml-2 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
                    {bizList.length}
                  </span>
                </h2>

                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {bizList.map((biz) => {
                    const isShared = biz.wa_method === 'shared';
                    const waNumber = WHATSAPP_NUMBERS[biz.country_code] || WHATSAPP_NUMBERS.US;
                    const waLink = isShared
                      ? `https://wa.me/${waNumber}?text=${encodeURIComponent(biz.bot_code)}`
                      : `https://wa.me/${waNumber}`;
                    const isExpanded = expanded === biz.id;

                    return (
                      <div
                        key={biz.id}
                        className="rounded-2xl border border-gray-200 bg-white p-5 transition hover:border-brand/30 hover:shadow-md"
                      >
                        {/* Header */}
                        <div className="flex items-start gap-3">
                          <span className="text-3xl">{CATEGORY_ICONS[biz.category] || '🏢'}</span>
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-bold text-gray-900 truncate">{biz.name}</h3>
                            <p className="text-xs text-gray-500 capitalize">{biz.category.replace(/_/g, ' ')} &middot; {biz.city || 'N/A'}</p>
                          </div>
                        </div>

                        {/* Capabilities */}
                        <div className="mt-3 flex flex-wrap gap-1">
                          {biz.capabilities.slice(0, 5).map(cap => (
                            <span key={cap} className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700">
                              {CAPABILITY_LABELS[cap] || cap}
                            </span>
                          ))}
                          {biz.capabilities.length > 5 && (
                            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">
                              +{biz.capabilities.length - 5} more
                            </span>
                          )}
                        </div>

                        {/* Services (expandable) */}
                        {biz.services.length > 0 && (
                          <div className="mt-3">
                            <button
                              onClick={() => setExpanded(isExpanded ? null : biz.id)}
                              className="text-xs font-medium text-brand hover:underline"
                            >
                              {isExpanded ? 'Hide' : 'View'} {biz.services.length} services
                            </button>
                            {isExpanded && (
                              <div className="mt-2 space-y-1">
                                {biz.services.map(s => (
                                  <div key={s.id} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-1.5">
                                    <span className="text-xs text-gray-700">{s.name}</span>
                                    <span className="text-xs font-medium text-gray-900">
                                      {formatCurrency(s.price, biz.country_code)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* WhatsApp CTA */}
                        <div className="mt-4 rounded-xl bg-gray-50 p-3">
                          {isShared ? (
                            <div>
                              <p className="text-[10px] text-gray-400 uppercase font-semibold">Shared WhatsApp Number</p>
                              <p className="mt-1 text-xs text-gray-600">
                                Text <span className="font-mono font-bold text-brand">{biz.bot_code}</span> to <span className="font-medium text-gray-900">+{waNumber.replace(/(\d{1})(\d{3})(\d{3})(\d{4})/, '$1-$2-$3-$4')}</span>
                              </p>
                            </div>
                          ) : (
                            <div>
                              <p className="text-[10px] text-gray-400 uppercase font-semibold">Dedicated WhatsApp</p>
                              <p className="mt-1 text-xs text-gray-600">Message them directly on their own number</p>
                            </div>
                          )}
                          <div className="mt-2 flex gap-2">
                          <a
                            href={waLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#25D366] py-2.5 text-sm font-bold text-white transition hover:bg-[#20BD5A]"
                          >
                            <svg aria-hidden="true" className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/></svg>
                            WhatsApp
                          </a>
                          {biz.slug && (biz.capabilities.includes('scheduling') || biz.capabilities.includes('appointment') || biz.capabilities.includes('ticketing')) && (
                            <Link
                              href={`/b/${biz.slug}`}
                              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-sm font-bold text-white transition hover:bg-brand-600"
                            >
                              <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                              Book Online
                            </Link>
                          )}
                        </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* CTA for businesses */}
        <div className="mt-16 rounded-2xl bg-gradient-to-br from-brand-900 via-brand to-brand-700 p-8 text-center text-white">
          <h2 className="text-2xl font-bold">Want your business listed here?</h2>
          <p className="mt-2 text-brand-200">Get started with Waaiio and reach customers on WhatsApp.</p>
          <Link
            href="/get-started"
            className="mt-5 inline-block rounded-xl bg-accent px-8 py-3 text-sm font-bold text-gray-900 shadow-lg transition hover:bg-accent-400"
          >
            Get Started Free
          </Link>
        </div>
      </div>
    </div>
  );
}
