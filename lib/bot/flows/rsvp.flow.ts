import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { getFlowCopy } from './flow-localization';
import { getLocale, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { getPoweredByFooter } from '@/lib/whitelabel';

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
          } catch (err) { logger.warn('[RSVP] Date formatting failed (keeping raw):', err); }
        }

        let timeLabel = eventTime;
        if (eventTime) {
          try {
            const [h, m] = eventTime.split(':');
            const dt = new Date();
            dt.setHours(parseInt(h, 10), parseInt(m, 10));
            timeLabel = dt.toLocaleTimeString(getLocale(cc), { hour: 'numeric', minute: '2-digit' });
          } catch (err) { logger.warn('[RSVP] Time formatting failed (keeping raw):', err); }
        }

        const lines = [
          getFlowCopy(ctx.copyLang, 'rsvp.invited'),
          '',
          `🎪 *${eventName}*`,
          eventDate ? `📅 ${dateLabel}${timeLabel ? ` at ${timeLabel}` : ''}` : '',
          eventVenue ? `📍 ${eventVenue}` : '',
          dressCode ? `👔 Dress code: ${dressCode}` : '',
          inviteMessage ? `\n${inviteMessage}` : '',
          '',
          getFlowCopy(ctx.copyLang, 'rsvp.attending'),
        ].filter(Boolean);

        return [
          { type: 'text', text: lines.join('\n') },
          {
            type: 'buttons',
            body: getFlowCopy(ctx.copyLang, 'rsvp.rsvp_label'),
            buttons: [
              { id: 'rsvp_yes', title: getFlowCopy(ctx.copyLang, 'rsvp.yes_there') },
              { id: 'rsvp_maybe', title: getFlowCopy(ctx.copyLang, 'rsvp.maybe') },
              { id: 'rsvp_no', title: getFlowCopy(ctx.copyLang, 'rsvp.cant_make_it') },
            ],
          },
        ];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
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
        return { valid: false, errorMessage: getFlowCopy(ctx.copyLang, 'rsvp.tap_hint') };
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
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: getFlowCopy(ctx.copyLang, 'rsvp.how_many'),
          buttons: [
            { id: '1', title: getFlowCopy(ctx.copyLang, 'rsvp.just_me') },
            { id: '2', title: getFlowCopy(ctx.copyLang, 'rsvp.two') },
            { id: '3', title: getFlowCopy(ctx.copyLang, 'rsvp.three') },
          ],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const num = parseInt(input, 10);
        const maxPlusOnes = (ctx.session.session_data.rsvp_max_plus_ones as number) || 3;

        if (isNaN(num) || num < 1) {
          return { valid: false, errorMessage: getFlowCopy(ctx.copyLang, 'rsvp.select_guests') };
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
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        return [{
          type: 'text',
          text: getFlowCopy(ctx.copyLang, 'rsvp.dietary'),
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
            text: getFlowCopy(ctx.copyLang, 'rsvp.declined') + getPoweredByFooter(ctx.business?.subscription_tier),
          }];
        }

        if (response === 'maybe') {
          return [{
            type: 'text',
            text: getFlowCopy(ctx.copyLang, 'rsvp.maybe_response') + getPoweredByFooter(ctx.business?.subscription_tier),
          }];
        }

        // Accepted
        let dateLabel = eventDate;
        if (eventDate) {
          try {
            dateLabel = new Date(eventDate + 'T00:00').toLocaleDateString(getLocale(cc), {
              weekday: 'long', day: 'numeric', month: 'long',
            });
          } catch (err) { logger.warn('[RSVP] Date/time formatting failed (keeping raw):', err); }
        }

        let timeLabel = eventTime;
        if (eventTime) {
          try {
            const [h, m] = eventTime.split(':');
            const dt = new Date();
            dt.setHours(parseInt(h, 10), parseInt(m, 10));
            timeLabel = dt.toLocaleTimeString(getLocale(cc), { hour: 'numeric', minute: '2-digit' });
          } catch (err) { logger.warn('[RSVP] Date/time formatting failed (keeping raw):', err); }
        }

        const totalGuests = 1 + plusOnes;
        const guestLabel = plusOnes > 0 ? `${totalGuests} guests (you + ${plusOnes})` : '1 guest (just you)';

        const lines = [
          `🎉 *You're in! Can't wait to see you at ${eventName}!* 🥳🔥`,
          '',
          eventDate ? `📅 ${dateLabel}${timeLabel ? ` at ${timeLabel}` : ''}` : '',
          eventVenue ? `📍 ${eventVenue}` : '',
          `👥 ${guestLabel}`,
          dietaryNotes ? `🍽️ Dietary: ${dietaryNotes}` : '',
          '',
          getFlowCopy(ctx.copyLang, 'rsvp.see_you'),
          '',
          ...(getPoweredByFooter(ctx.business?.subscription_tier) ? [getFlowCopy(ctx.copyLang, 'greeting.powered_by')] : []),
        ].filter(Boolean);

        return [{ type: 'text', text: lines.join('\n') }];
      },
      async validate(): Promise<ValidationResult> {
        return { valid: true };
      },
      async next() { return null; },
    },
  ],
};
