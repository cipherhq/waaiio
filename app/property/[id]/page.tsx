import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase/service';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { notFound } from 'next/navigation';

export const revalidate = 60; // ISR: regenerate every 60 seconds

interface PageProps {
  params: Promise<{ id: string }>;
}

async function getProperty(id: string) {
  const supabase = createServiceClient();

  const { data: property } = await supabase
    .from('properties')
    .select(`
      id, name, description, property_type, price, deposit_amount,
      max_guests, bedrooms, bathrooms, amenities, photos, address,
      is_active, business_id,
      businesses:business_id (
        id, name, slug, logo_url, country_code, phone, whatsapp_number
      )
    `)
    .eq('id', id)
    .eq('is_active', true)
    .single();

  return property;
}

async function getBlockedDates(propertyId: string, businessId: string) {
  const supabase = createServiceClient();
  const todayStr = new Date().toISOString().split('T')[0];

  const [{ data: blocked }, { data: booked }] = await Promise.all([
    supabase
      .from('property_blocked_dates')
      .select('date_from, date_to')
      .eq('property_id', propertyId)
      .gte('date_to', todayStr),
    supabase
      .from('reservations')
      .select('check_in, check_out')
      .eq('business_id', businessId)
      .eq('property_id', propertyId)
      .in('status', ['pending', 'confirmed', 'checked_in'])
      .gte('check_out', todayStr)
      .limit(200),
  ]);

  return [
    ...(blocked || []).map(b => ({ from: b.date_from, to: b.date_to })),
    ...(booked || []).map(r => ({ from: r.check_in, to: r.check_out })),
  ];
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const property = await getProperty(id);

  if (!property) {
    return { title: 'Property Not Found | Waaiio' };
  }

  const biz = property.businesses as unknown as { name: string; country_code?: string } | null;
  const cc = (biz?.country_code || 'NG') as CountryCode;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  const photos = (property.photos as string[]) || [];
  const desc = property.description || `Book ${property.name} - ${formatCurrency(property.price, cc)}/night. Up to ${property.max_guests} guests.`;

  return {
    title: `${property.name} | ${biz?.name || 'Property'} | Waaiio`,
    description: desc,
    alternates: { canonical: `${baseUrl}/property/${id}` },
    openGraph: {
      title: property.name,
      description: desc,
      url: `${baseUrl}/property/${id}`,
      images: photos.length > 0 ? [{ url: photos[0] }] : [{ url: `${baseUrl}/opengraph-image` }],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: property.name,
      description: desc,
      images: photos.length > 0 ? [photos[0]] : undefined,
    },
  };
}

export default async function PublicPropertyPage({ params }: PageProps) {
  const { id } = await params;
  const property = await getProperty(id);

  if (!property) {
    notFound();
  }

  const biz = property.businesses as unknown as {
    id: string;
    name: string;
    slug: string;
    logo_url: string | null;
    country_code?: string;
    phone?: string;
    whatsapp_number?: string;
  } | null;

  const cc = (biz?.country_code || 'NG') as CountryCode;
  const photos = (property.photos as string[]) || [];
  const amenities = (property.amenities as string[]) || [];
  const blockedRanges = await getBlockedDates(property.id, property.business_id);

  // Build WhatsApp link
  const whatsappNumber = biz?.whatsapp_number || biz?.phone || '';
  const whatsappLink = whatsappNumber
    ? `https://wa.me/${whatsappNumber.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(`Hi, I'd like to book ${property.name}`)}`
    : null;

  // Build availability calendar (next 60 days)
  const calendarDays: Array<{ date: string; label: string; available: boolean }> = [];
  for (let i = 1; i <= 60; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const isBlocked = blockedRanges.some(r => dateStr >= r.from && dateStr <= r.to);
    calendarDays.push({
      date: dateStr,
      label: d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }),
      available: !isBlocked,
    });
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            {biz?.logo_url && (
              <Image src={biz.logo_url} alt={biz.name} width={36} height={36} className="rounded-full object-cover" />
            )}
            <div>
              <p className="text-sm font-semibold text-gray-900">{biz?.name || 'Property'}</p>
              {biz?.slug && (
                <Link href={`/b/${biz.slug}`} className="text-xs text-brand-600 hover:underline">
                  View all listings
                </Link>
              )}
            </div>
          </div>
          {whatsappLink && (
            <a
              href={whatsappLink}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-[#25D366] px-4 py-2 text-sm font-medium text-white hover:bg-[#20bd5a] transition"
            >
              Book on WhatsApp
            </a>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:py-8">
        {/* Photo Gallery */}
        {photos.length > 0 && (
          <div className="mb-6 overflow-hidden rounded-2xl">
            {photos.length === 1 ? (
              <div className="relative aspect-[16/9] w-full">
                <Image src={photos[0]} alt={property.name} fill className="object-cover" sizes="(max-width: 768px) 100vw, 1024px" priority />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {/* First image large */}
                <div className="relative aspect-[4/3] sm:col-span-2 sm:row-span-2 lg:col-span-2">
                  <Image src={photos[0]} alt={property.name} fill className="rounded-lg object-cover" sizes="(max-width: 768px) 100vw, 680px" priority />
                </div>
                {/* Smaller images */}
                {photos.slice(1, 5).map((photo, i) => (
                  <div key={i} className="relative aspect-[4/3]">
                    <Image src={photo} alt={`${property.name} photo ${i + 2}`} fill className="rounded-lg object-cover" sizes="(max-width: 768px) 50vw, 340px" />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="grid gap-8 lg:grid-cols-3">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Title & Type */}
            <div>
              <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">{property.name}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-600">
                <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 capitalize">
                  {property.property_type}
                </span>
                {property.bedrooms > 0 && <span>{property.bedrooms} bedroom{property.bedrooms !== 1 ? 's' : ''}</span>}
                {property.bathrooms > 0 && <span>{property.bathrooms} bathroom{property.bathrooms !== 1 ? 's' : ''}</span>}
                {property.max_guests > 0 && <span>Up to {property.max_guests} guest{property.max_guests !== 1 ? 's' : ''}</span>}
              </div>
            </div>

            {/* Description */}
            {property.description && (
              <div>
                <h2 className="text-lg font-semibold text-gray-900">About this property</h2>
                <p className="mt-2 whitespace-pre-line text-gray-600 leading-relaxed">{property.description}</p>
              </div>
            )}

            {/* Amenities */}
            {amenities.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Amenities</h2>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {amenities.map((amenity, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-lg border border-gray-100 bg-white px-3 py-2 text-sm text-gray-700">
                      <span className="text-brand-500">&#10003;</span>
                      {amenity}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Address */}
            {property.address && (
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Location</h2>
                <p className="mt-2 text-gray-600">{property.address}</p>
              </div>
            )}

            {/* Availability Calendar */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Availability</h2>
              <p className="mt-1 text-sm text-gray-500">Next 60 days</p>
              <div className="mt-3 grid grid-cols-7 gap-1 sm:grid-cols-10">
                {calendarDays.slice(0, 30).map(day => (
                  <div
                    key={day.date}
                    className={`rounded-lg border px-1.5 py-2 text-center text-xs ${
                      day.available
                        ? 'border-green-200 bg-green-50 text-green-700'
                        : 'border-red-200 bg-red-50 text-red-500 line-through'
                    }`}
                    title={day.available ? 'Available' : 'Unavailable'}
                  >
                    {day.label}
                  </div>
                ))}
              </div>
              <div className="mt-2 flex gap-4 text-xs text-gray-500">
                <div className="flex items-center gap-1.5">
                  <div className="h-3 w-3 rounded border border-green-200 bg-green-50" />
                  <span>Available</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="h-3 w-3 rounded border border-red-200 bg-red-50" />
                  <span>Unavailable</span>
                </div>
              </div>
            </div>
          </div>

          {/* Sidebar - Pricing & Booking */}
          <div className="lg:col-span-1">
            <div className="sticky top-6 space-y-4">
              {/* Price Card */}
              <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="text-center">
                  <p className="text-3xl font-bold text-gray-900">{formatCurrency(property.price, cc)}</p>
                  <p className="text-sm text-gray-500">per night</p>
                </div>

                {property.deposit_amount > 0 && (
                  <div className="mt-4 rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2 text-center">
                    <p className="text-xs text-yellow-700">
                      Deposit required: {formatCurrency(property.deposit_amount, cc)}
                    </p>
                  </div>
                )}

                <div className="mt-4 space-y-2 text-sm text-gray-600">
                  {property.max_guests > 0 && (
                    <div className="flex justify-between">
                      <span>Max guests</span>
                      <span className="font-medium">{property.max_guests}</span>
                    </div>
                  )}
                  {property.bedrooms > 0 && (
                    <div className="flex justify-between">
                      <span>Bedrooms</span>
                      <span className="font-medium">{property.bedrooms}</span>
                    </div>
                  )}
                  {property.bathrooms > 0 && (
                    <div className="flex justify-between">
                      <span>Bathrooms</span>
                      <span className="font-medium">{property.bathrooms}</span>
                    </div>
                  )}
                </div>

                {whatsappLink && (
                  <a
                    href={whatsappLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-[#25D366] px-4 py-3 text-sm font-semibold text-white hover:bg-[#20bd5a] transition"
                  >
                    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                    </svg>
                    Book on WhatsApp
                  </a>
                )}
              </div>

              {/* Business Info */}
              {biz && (
                <div className="rounded-2xl border border-gray-200 bg-white p-4">
                  <div className="flex items-center gap-3">
                    {biz.logo_url ? (
                      <Image src={biz.logo_url} alt={biz.name} width={40} height={40} className="rounded-full object-cover" />
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-600 font-bold">
                        {biz.name.charAt(0)}
                      </div>
                    )}
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{biz.name}</p>
                      <p className="text-xs text-gray-500">Hosted on Waaiio</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-16 border-t border-gray-200 bg-white py-6">
        <div className="mx-auto max-w-5xl px-4 text-center">
          <p className="text-xs text-gray-400">
            Powered by{' '}
            <a href="https://waaiio.com" className="text-brand-600 hover:underline" target="_blank" rel="noopener noreferrer">
              Waaiio
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
