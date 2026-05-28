import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import BookingForm from './BookingForm';

export const revalidate = 30; // ISR: regenerate every 30 seconds

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const supabase = await createClient();

  const { data: business } = await supabase
    .from('businesses')
    .select('name, description')
    .eq('slug', slug)
    .eq('is_active', true)
    .single();

  if (!business) {
    return { title: 'Business Not Found | Waaiio' };
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
  const desc = business.description || `Book services online with ${business.name} on Waaiio.`;
  return {
    title: `Book with ${business.name} | Waaiio`,
    description: desc,
    alternates: { canonical: `${baseUrl}/b/${slug}` },
    openGraph: {
      title: `Book with ${business.name}`,
      description: desc,
      url: `${baseUrl}/b/${slug}`,
      images: [{ url: `${baseUrl}/opengraph-image` }],
    },
  };
}

export default async function PublicBookingPage({ params }: PageProps) {
  const { slug } = await params;
  const supabase = await createClient();

  const { data: business } = await supabase
    .from('businesses')
    .select(
      'id, name, slug, logo_url, description, address, operating_hours, country_code',
    )
    .eq('slug', slug)
    .eq('is_active', true)
    .single();

  if (!business) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <h1 className="text-xl font-bold text-gray-900">Not Found</h1>
          <p className="mt-2 text-gray-500">
            This business does not exist or is unavailable.
          </p>
        </div>
      </div>
    );
  }

  const { data: services } = await supabase
    .from('services')
    .select(
      'id, name, description, price, deposit_amount, duration_minutes, buffer_minutes, max_capacity, image_url, metadata',
    )
    .eq('business_id', business.id)
    .eq('is_active', true)
    .order('sort_order');

  const serializedServices = (services || []).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    price: s.price,
    deposit_amount: s.deposit_amount,
    duration_minutes: s.duration_minutes,
    image_url: s.image_url,
    is_dropoff: (s.metadata as Record<string, unknown>)?.is_dropoff === true,
  }));

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: business.name,
    ...(business.description ? { description: business.description } : {}),
    ...(business.address ? { address: { '@type': 'PostalAddress', streetAddress: business.address } } : {}),
    url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com'}/b/${slug}`,
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <BookingForm
        business={{
        id: business.id,
        name: business.name,
        slug: business.slug,
        logo_url: business.logo_url,
        description: business.description,
        address: business.address,
        operating_hours: business.operating_hours as Record<
          string,
          { open?: string; close?: string; closed?: boolean }
        > | null,
        country_code: business.country_code,
      }}
      services={serializedServices}
    />
    </>
  );
}
