import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/service';

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const supabase = createServiceClient();

  // Look up invite by token to get event/party details
  const { data: invite } = await supabase
    .from('invites')
    .select('id, event_id, party_id')
    .eq('invite_token', token)
    .maybeSingle();

  if (invite?.event_id) {
    const { data: event } = await supabase
      .from('events')
      .select('name, date, venue, image_url, businesses(name)')
      .eq('id', invite.event_id)
      .single();

    if (event) {
      const biz = event.businesses as unknown as { name: string } | null;
      const hostName = biz?.name || 'Waaiio';
      const dateLabel = new Date(event.date + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

      return {
        title: `RSVP: ${event.name}`,
        description: `You're invited to ${event.name} by ${hostName}. ${dateLabel}${event.venue ? ` at ${event.venue}` : ''}.`,
        openGraph: {
          title: `RSVP: ${event.name}`,
          description: `You're invited to ${event.name} by ${hostName}. ${dateLabel}${event.venue ? ` at ${event.venue}` : ''}.`,
          images: event.image_url ? [{ url: event.image_url }] : [],
        },
      };
    }
  }

  if (invite?.party_id) {
    const { data: party } = await supabase
      .from('parties')
      .select('name, date, venue, image_url, businesses(name)')
      .eq('id', invite.party_id)
      .single();

    if (party) {
      const biz = party.businesses as unknown as { name: string } | null;
      const hostName = biz?.name || 'Waaiio';
      const dateLabel = new Date(party.date + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

      return {
        title: `RSVP: ${party.name}`,
        description: `You're invited to ${party.name} by ${hostName}. ${dateLabel}${party.venue ? ` at ${party.venue}` : ''}.`,
        openGraph: {
          title: `RSVP: ${party.name}`,
          description: `You're invited to ${party.name} by ${hostName}. ${dateLabel}${party.venue ? ` at ${party.venue}` : ''}.`,
          images: party.image_url ? [{ url: party.image_url }] : [],
        },
      };
    }
  }

  return {
    title: 'RSVP | Waaiio',
    description: 'Respond to your invitation on Waaiio.',
  };
}

export default function RsvpLayout({ children }: { children: React.ReactNode }) {
  return children;
}
