import { createServiceClient } from '@/lib/supabase/service';
import type { Metadata } from 'next';
import EventPurchaseForm from './EventPurchaseForm';

interface EventData {
  id: string;
  name: string;
  description: string | null;
  date: string;
  time: string | null;
  end_date: string | null;
  end_time: string | null;
  venue: string | null;
  total_tickets: number;
  tickets_sold: number;
  price: number;
  image_url: string | null;
  max_per_order: number | null;
  slug: string;
  businesses: {
    id: string;
    name: string;
    slug: string;
    logo_url: string | null;
    country_code: string;
    payment_gateway: string | null;
  };
  event_ticket_types: {
    id: string;
    name: string;
    price: number;
    total_tickets: number;
    tickets_sold: number;
    sort_order: number;
    is_active: boolean;
  }[];
}

async function getEvent(slug: string): Promise<EventData | null> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('events')
    .select(`
      id, name, description, date, time, end_date, end_time,
      venue, total_tickets, tickets_sold, price,
      image_url, max_per_order, slug,
      businesses!inner (
        id, name, slug, logo_url, country_code, payment_gateway
      ),
      event_ticket_types (
        id, name, price, total_tickets, tickets_sold, sort_order, is_active
      )
    `)
    .eq('slug', slug)
    .eq('status', 'published')
    .single();

  if (error || !data) return null;
  return data as unknown as EventData;
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const event = await getEvent(slug);

  if (!event) {
    return { title: 'Event Not Found | Waaiio' };
  }

  const business = event.businesses;
  const description = event.description
    ? event.description.slice(0, 160)
    : `Get tickets for ${event.name} by ${business.name}`;

  return {
    title: `${event.name} | ${business.name}`,
    description,
    openGraph: {
      title: event.name,
      description,
      ...(event.image_url ? { images: [{ url: event.image_url }] } : {}),
      type: 'website',
    },
    twitter: {
      card: event.image_url ? 'summary_large_image' : 'summary',
      title: event.name,
      description,
      ...(event.image_url ? { images: [event.image_url] } : {}),
    },
  };
}

export default async function EventPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const event = await getEvent(slug);

  if (!event) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="max-w-sm text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-2xl">
            ?
          </div>
          <h1 className="mt-4 text-2xl font-bold text-gray-900">Event Not Found</h1>
          <p className="mt-2 text-sm text-gray-600">
            This event may have ended or the link is invalid.
          </p>
          <a
            href="https://www.waaiio.com"
            className="mt-6 inline-block rounded-xl bg-[#6C2BD9] px-6 py-3 text-sm font-semibold text-white hover:bg-[#5a23b5]"
          >
            Visit Waaiio
          </a>
        </div>
      </div>
    );
  }

  const business = event.businesses;
  const available = event.total_tickets - event.tickets_sold;

  const ticketTypes = (event.event_ticket_types || [])
    .filter((tt) => tt.is_active)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((tt) => ({
      id: tt.id,
      name: tt.name,
      price: tt.price,
      available: tt.total_tickets - tt.tickets_sold,
    }));

  return (
    <EventPurchaseForm
      event={{
        id: event.id,
        name: event.name,
        description: event.description,
        date: event.date,
        time: event.time,
        end_date: event.end_date,
        end_time: event.end_time,
        venue: event.venue,
        price: event.price,
        image_url: event.image_url,
        max_per_order: event.max_per_order,
        slug: event.slug,
        available,
      }}
      ticketTypes={ticketTypes}
      business={{
        id: business.id,
        name: business.name,
        slug: business.slug,
        logo_url: business.logo_url,
        country_code: business.country_code,
        payment_gateway: business.payment_gateway,
      }}
    />
  );
}
