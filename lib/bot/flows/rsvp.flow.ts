import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { getLocale, type CountryCode } from '@/lib/constants';

export const rsvpFlow: FlowDefinition = {
  type: 'ticketing', // piggybacks on ticketing flow type
  steps: [
    // ── Welcome + RSVP buttons ──
    {
      id: 'rsvp_welcome',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        // Support both event and party invites
        const eventName = d.rsvp_event_name as string || d.rsvp_party_name as string || 'Event';
        const eventDate = d.rsvp_event_date as string || d.rsvp_party_date as string || '';
        const eventTime = d.rsvp_event_time as string || d.rsvp_party_time as string || '';
        const eventVenue = d.rsvp_event_venue as string || d.rsvp_party_venue as string || '';
        const inviteMessage = d.rsvp_invite_message as string || '';
        const dressCode = d.rsvp_dress_code as string || '';
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;

        let dateLabel = eventDate;
        if (eventDate) {
          try {
            dateLabel = new Date(eventDate + 'T00:00').toLocaleDateString(getLocale(cc), {
              weekday: 'long', day: 'numeric', month: 'long',
            });
          } catch { /* keep raw date */ }
        }

        let timeLabel = eventTime;
        if (eventTime) {
          try {
            const [h, m] = eventTime.split(':');
            const dt = new Date();
            dt.setHours(parseInt(h, 10), parseInt(m, 10));
            timeLabel = dt.toLocaleTimeString(getLocale(cc), { hour: 'numeric', minute: '2-digit' });
          } catch { /* keep raw time */ }
        }

        const lines = [
          `*You're Invited!*`,
          '',
          `🎪 *${eventName}*`,
          eventDate ? `📅 ${dateLabel}${timeLabel ? ` at ${timeLabel}` : ''}` : '',
          eventVenue ? `📍 ${eventVenue}` : '',
          dressCode ? `👔 Dress code: ${dressCode}` : '',
          inviteMessage ? `\n${inviteMessage}` : '',
          '',
          'Will you be attending?',
        ].filter(Boolean);

        return [
          { type: 'text', text: lines.join('\n') },
          {
            type: 'buttons',
            body: 'RSVP:',
            buttons: [
              { id: 'rsvp_yes', title: 'Yes, I\'ll be there!' },
              { id: 'rsvp_maybe', title: 'Maybe' },
              { id: 'rsvp_no', title: 'Can\'t make it' },
            ],
          },
        ];
      },
      async validate(input: string): Promise<ValidationResult> {
        const text = input.toLowerCase();
        if (text === 'rsvp_yes' || text === 'yes' || text === 'yeah' || text === 'yep' || /i'?ll be there/i.test(text)) {
          return { valid: true, data: { rsvp_response: 'accepted' } };
        }
        if (text === 'rsvp_maybe' || text === 'maybe' || text === 'not sure' || text === 'perhaps') {
          return { valid: true, data: { rsvp_response: 'maybe' } };
        }
        if (text === 'rsvp_no' || text === 'no' || text === 'nope' || text === 'nah' || /can'?t make it/i.test(text)) {
          return { valid: true, data: { rsvp_response: 'declined' } };
        }
        return { valid: false, errorMessage: 'Please tap *Yes*, *Maybe*, or *Can\'t make it*.' };
      },
      async next(ctx: FlowContext) {
        const response = ctx.session.session_data.rsvp_response as string;
        if (response === 'accepted') return 'rsvp_plus_ones';
        if (response === 'maybe') return 'rsvp_confirmed';
        // declined
        return 'rsvp_confirmed';
      },
    },

    // ── Plus ones ──
    {
      id: 'rsvp_plus_ones',
      async skipIf(ctx: FlowContext): Promise<boolean> {
        const allowPlusOnes = ctx.session.session_data.rsvp_allow_plus_ones as boolean;
        if (!allowPlusOnes) {
          ctx.session.session_data.rsvp_plus_ones = 0;
          return true;
        }
        return false;
      },
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: 'How many guests including you?',
          buttons: [
            { id: '1', title: 'Just me' },
            { id: '2', title: '2 (me + 1)' },
            { id: '3', title: '3 (me + 2)' },
          ],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const num = parseInt(input, 10);
        const maxPlusOnes = (ctx.session.session_data.rsvp_max_plus_ones as number) || 3;

        if (isNaN(num) || num < 1) {
          return { valid: false, errorMessage: 'Please select how many guests.' };
        }
        if (num > maxPlusOnes + 1) {
          return { valid: false, errorMessage: `Maximum ${maxPlusOnes + 1} guests (you + ${maxPlusOnes}).` };
        }
        return { valid: true, data: { rsvp_plus_ones: num - 1 } };
      },
      async next() { return 'rsvp_dietary'; },
    },

    // ── Dietary requirements ──
    {
      id: 'rsvp_dietary',
      async skipIf(ctx: FlowContext): Promise<boolean> {
        const askDietary = ctx.session.session_data.rsvp_ask_dietary as boolean;
        return !askDietary;
      },
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'text',
          text: 'Any dietary requirements? (Type your needs or send *skip*)',
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const text = input.trim();
        if (text.toLowerCase() === 'skip' || text.toLowerCase() === 'none' || text.toLowerCase() === 'no') {
          return { valid: true, data: { rsvp_dietary_notes: null } };
        }
        return { valid: true, data: { rsvp_dietary_notes: text } };
      },
      async next() { return 'rsvp_confirmed'; },
    },

    // ── Save RSVP and confirm ──
    {
      id: 'rsvp_confirmed',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const response = d.rsvp_response as string;
        const inviteId = d.rsvp_invite_id as string;
        const eventName = d.rsvp_event_name as string || d.rsvp_party_name as string || 'Event';
        const eventDate = d.rsvp_event_date as string || d.rsvp_party_date as string || '';
        const eventTime = d.rsvp_event_time as string || d.rsvp_party_time as string || '';
        const eventVenue = d.rsvp_event_venue as string || d.rsvp_party_venue as string || '';
        const plusOnes = (d.rsvp_plus_ones as number) || 0;
        const dietaryNotes = d.rsvp_dietary_notes as string | null;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;

        // Save the RSVP to database
        if (inviteId) {
          const updateData: Record<string, unknown> = {
            status: response,
            plus_ones: plusOnes,
            responded_at: new Date().toISOString(),
          };
          if (dietaryNotes) updateData.dietary_notes = dietaryNotes;

          await ctx.supabase
            .from('event_invites')
            .update(updateData)
            .eq('id', inviteId);
        }

        // Build confirmation message based on response
        if (response === 'declined') {
          return [{
            type: 'text',
            text: `Sorry to miss you! Maybe next time 🙏\n\nIf you change your mind, just send *rsvp* again.\n\n💡 *What you can do:*\n• Type *Hi* to explore more`,
          }];
        }

        if (response === 'maybe') {
          return [{
            type: 'text',
            text: `Got it! We'll check back with you closer to the date.\n\nIf you decide, just send *yes* or *no* anytime.\n\n💡 *What you can do:*\n• Type *Hi* to explore more`,
          }];
        }

        // Accepted
        let dateLabel = eventDate;
        if (eventDate) {
          try {
            dateLabel = new Date(eventDate + 'T00:00').toLocaleDateString(getLocale(cc), {
              weekday: 'long', day: 'numeric', month: 'long',
            });
          } catch { /* keep raw */ }
        }

        let timeLabel = eventTime;
        if (eventTime) {
          try {
            const [h, m] = eventTime.split(':');
            const dt = new Date();
            dt.setHours(parseInt(h, 10), parseInt(m, 10));
            timeLabel = dt.toLocaleTimeString(getLocale(cc), { hour: 'numeric', minute: '2-digit' });
          } catch { /* keep raw */ }
        }

        const totalGuests = 1 + plusOnes;
        const guestLabel = plusOnes > 0 ? `${totalGuests} guests (you + ${plusOnes})` : '1 guest (just you)';

        const lines = [
          `✅ You're confirmed for *${eventName}*!`,
          '',
          eventDate ? `📅 ${dateLabel}${timeLabel ? ` at ${timeLabel}` : ''}` : '',
          eventVenue ? `📍 ${eventVenue}` : '',
          `👥 ${guestLabel}`,
          dietaryNotes ? `🍽️ Dietary: ${dietaryNotes}` : '',
          '',
          `We'll send you a reminder before the event. See you there!`,
        ].filter(Boolean);

        return [{ type: 'text', text: lines.join('\n') + `\n\n💡 *What you can do:*\n• Type *Hi* to explore more` }];
      },
      async validate(): Promise<ValidationResult> {
        return { valid: true };
      },
      async next() { return null; },
    },
  ],
};
