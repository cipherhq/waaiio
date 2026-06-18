import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/service';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const supabase = createServiceClient();

  // Try events first
  const { data: event } = await supabase
    .from('events')
    .select('name, date, venue, image_url, description, business_id, businesses(name, owner_id)')
    .eq('id', id)
    .eq('status', 'published')
    .single();

  if (event) {
    const biz = event.businesses as unknown as { name: string; owner_id?: string } | null;
    let hostName = biz?.name || 'Waaiio';
    if (biz?.owner_id) {
      const { data: owner } = await supabase.from('profiles').select('first_name').eq('id', biz.owner_id).single();
      if (owner?.first_name) hostName = owner.first_name;
    }
    const dateLabel = new Date(event.date + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    return {
      title: `${hostName} invites you to ${event.name}`,
      description: `${dateLabel}${event.venue ? ` at ${event.venue}` : ''}. RSVP now!`,
      openGraph: {
        title: `You're invited: ${event.name}`,
        description: `${hostName} invites you to ${event.name}. ${dateLabel}${event.venue ? ` at ${event.venue}` : ''}.`,
        images: event.image_url ? [{ url: event.image_url }] : [],
      },
    };
  }

  // Try parties
  const { data: party } = await supabase
    .from('parties')
    .select('name, date, venue, image_url, description, business_id, businesses(name, owner_id)')
    .eq('id', id)
    .single();

  if (party) {
    const biz = party.businesses as unknown as { name: string; owner_id?: string } | null;
    let hostName = biz?.name || 'Waaiio';
    if (biz?.owner_id) {
      const { data: owner } = await supabase.from('profiles').select('first_name').eq('id', biz.owner_id).single();
      if (owner?.first_name) hostName = owner.first_name;
    }
    const dateLabel = new Date(party.date + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    return {
      title: `${hostName} invites you to ${party.name}`,
      description: `${dateLabel}${party.venue ? ` at ${party.venue}` : ''}. RSVP now!`,
      openGraph: {
        title: `You're invited: ${party.name}`,
        description: `${hostName} invites you to ${party.name}. ${dateLabel}${party.venue ? ` at ${party.venue}` : ''}.`,
        images: party.image_url ? [{ url: party.image_url }] : [],
      },
    };
  }

  return {
    title: 'You\'re Invited | Waaiio',
    description: 'RSVP to this event on Waaiio.',
  };
}

export default function JoinEventLayout({ children }: { children: React.ReactNode }) {
  return children;
}
