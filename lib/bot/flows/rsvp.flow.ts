import { completePartyRsvp } from '@/lib/parties/rsvp-completion';
import { validateAnswers, type PartyQuestion, type PartyAnswers } from '@/lib/parties/rsvp-questions';
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
        const maxPlusOnes = (ctx.session.session_data.rsvp_max_plus_ones as number | null) ?? 3;

        if (isNaN(num) || num < 1) {
          return { valid: false, errorMessage: getFlowCopy(ctx.copyLang, 'rsvp.select_guests') };
        }
        if (num > maxPlusOnes + 1) {
          return { valid: false, errorMessage: `Maximum ${maxPlusOnes + 1} guests (you + ${maxPlusOnes}).` };
        }

        // ── Attendee capacity enforcement (#661) ──
        const partyId = ctx.session.session_data.rsvp_party_id as string | undefined;
        if (partyId && ctx.supabase) {
          const { data: party } = await ctx.supabase
            .from('parties')
            .select('max_guests')
            .eq('id', partyId)
            .single();

          if (party?.max_guests && party.max_guests > 0) {
            const { data: attendeeData } = await ctx.supabase
              .from('event_invites')
              .select('plus_ones')
              .eq('party_id', partyId)
              .eq('business_id', ctx.session.business_id)
              .neq('id', ctx.session.session_data.rsvp_invite_id)
              .in('status', ['accepted', 'pending', 'maybe']);

            const currentAttendees = (attendeeData || []).reduce(
              (sum: number, inv: { plus_ones: number }) => sum + 1 + (inv.plus_ones || 0), 0
            );
            // Other attendees exclude this invite; add its entire proposed party size.
            const requestedPlusOnes = num - 1;
            if (currentAttendees + 1 + requestedPlusOnes > party.max_guests) {
              const remaining = Math.max(0, party.max_guests - currentAttendees - 1);
              const maxAllowed = remaining + 1; // +1 because guest is already counted
              return {
                valid: false,
                errorMessage: remaining > 0
                  ? `Only ${maxAllowed} spots left (you + ${remaining}). Please choose a smaller number.`
                  : 'Sorry, the party is at full capacity. No plus-ones available.',
              };
            }
          }
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
      async next(ctx) { return ctx.session.session_data.rsvp_party_id ? 'rsvp_questions' : 'rsvp_confirmed'; },
    },

    {
      id: 'rsvp_questions',
      async skipIf(ctx) {
        const d = ctx.session.session_data;
        return d.rsvp_response !== 'accepted' || !((d.rsvp_questions as PartyQuestion[] || []).length);
      },
      async prompt(ctx) {
        const d = ctx.session.session_data;
        const q = (d.rsvp_questions as PartyQuestion[])[Number(d.rsvp_question_index || 0)];
        if (!q) return [{ type: 'text', text: 'Reply confirm to save your response.' }];
        const choices = q.type === 'yes_no' ? '\nReply yes or no.' : q.options ? '\n' + q.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n') : '\nUse up to 500 characters.';
        return [{ type: 'text', text: q.label + choices + (q.required ? '' : '\nReply skip to leave this unanswered.') }];
      },
      async validate(input, ctx) {
        const d = ctx.session.session_data;
        const questions = d.rsvp_questions as PartyQuestion[];
        const index = Number(d.rsvp_question_index || 0);
        const q = questions[index];
        if (!q) return { valid: true };
        const answers = { ...(d.rsvp_answers as PartyAnswers || {}) };
        const text = input.trim();
        if (text.toLowerCase() === 'skip' && !q.required) delete answers[q.id];
        else {
          let answer: unknown = text;
          if (q.type === 'yes_no') answer = /^yes$/i.test(text) ? true : /^no$/i.test(text) ? false : text;
          if (q.type === 'single_choice') answer = /^\d+$/.test(text) ? q.options?.[Number(text) - 1]?.id : text;
          try { Object.assign(answers, validateAnswers([q], { [q.id]: answer })); }
          catch (e) { return { valid: false, errorMessage: e instanceof Error ? e.message : 'Please check your answer.' }; }
        }
        return { valid: true, data: { rsvp_answers: answers, rsvp_question_index: index + 1 } };
      },
      async next(ctx) {
        const d = ctx.session.session_data;
        return Number(d.rsvp_question_index || 0) < (d.rsvp_questions as PartyQuestion[] || []).length ? 'rsvp_questions' : 'rsvp_confirmed';
      },
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
        if (d.rsvp_party_id) {
          if (!d.rsvp_token || !ctx.session.business_id) return [{ type: 'text', text: 'Please reopen your invitation to respond.' }];
          const result = await completePartyRsvp(ctx.supabase, String(d.rsvp_token), {
            status: response, plus_ones: plusOnes, answers: d.rsvp_answers || {}, revision: d.rsvp_revision,
            ...(Object.hasOwn(d, 'rsvp_dietary_notes') ? { dietary_notes: dietaryNotes } : {}),
          }, { sender: ctx.from, businessId: ctx.session.business_id });
          d.rsvp_save_failed = !result.ok;
          if (!result.ok) return [{ type: 'text', text: result.error + ' Reply retry to try again, or reopen your invitation to review it.' }];
        } else if (inviteId) {
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
      async next(ctx) { return ctx.session.session_data.rsvp_save_failed ? 'rsvp_confirmed' : null; },
    },
  ],
};
