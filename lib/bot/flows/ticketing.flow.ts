import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { createWhatsAppUser, findUserByPhone } from './shared/user';
import { initializePayment, verifyPayment, recordPlatformFee } from './shared/payment';
import { getTicketConfirmationMessage } from './shared/templates';
import { getTermsPrompt } from './shared/terms';
import { sendTicketsAfterPurchase } from './shared/send-tickets';
import { notifyOwnerNewTicketSale } from './shared/notify-owner';
import { createNotification } from './shared/notifications';
import { formatCurrency, getLocale, type CountryCode } from '@/lib/constants';
import type { SubscriptionTier } from '@/lib/constants';

export const ticketingFlow: FlowDefinition = {
  type: 'ticketing',
  steps: [
    // ── Select Event ──
    {
      id: 'select_event',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        if (!ctx.business) return [{ type: 'text', text: 'Business not found.' }];

        const { data: events } = await ctx.supabase
          .from('events')
          .select('id, name, date, venue, price, total_tickets, tickets_sold, image_url')
          .eq('business_id', ctx.business.id)
          .in('status', ['published'])
          .gte('date', new Date().toISOString().split('T')[0])
          .order('date')
          .limit(10);

        if (!events || events.length === 0) {
          return [{ type: 'text', text: 'No upcoming events right now. Check back soon! 🎪' }];
        }

        return [{
          type: 'list',
          title: 'Upcoming Events',
          body: `🎪 Events at ${ctx.business.name}:`,
          buttonLabel: 'View Events',
          items: events.map(e => {
            const available = e.total_tickets - e.tickets_sold;
            const cc = (ctx.business?.country_code || 'NG') as CountryCode;
            const dateLabel = new Date(e.date + 'T00:00').toLocaleDateString(getLocale(cc), { day: 'numeric', month: 'short' });
            return {
              title: e.name,
              description: `${dateLabel} • ${formatCurrency(e.price, cc)} • ${available} left`,
              postbackText: e.id,
            };
          }),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const { data: event } = await ctx.supabase
          .from('events')
          .select('id, name, date, time, venue, price, total_tickets, tickets_sold, max_per_order, image_url')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .single();

        if (!event) return { valid: false, errorMessage: 'Please select a valid event.' };

        const available = event.total_tickets - event.tickets_sold;
        if (available <= 0) {
          return { valid: false, errorMessage: `Sorry, ${event.name} is sold out! 😞` };
        }

        return {
          valid: true,
          data: {
            event_id: event.id,
            event_name: event.name,
            event_date: event.date,
            event_time: event.time,
            event_venue: event.venue,
            event_price: event.price,
            event_available: available,
            event_max_per_order: event.max_per_order,
            event_image_url: event.image_url || null,
          },
        };
      },
      async next() { return 'select_ticket_type'; },
    },

    // ── Select Ticket Type (skipped if no types exist) ──
    {
      id: 'select_ticket_type',
      async skipIf(ctx: FlowContext): Promise<boolean> {
        const eventId = ctx.session.session_data.event_id as string;
        const { data: types } = await ctx.supabase
          .from('event_ticket_types')
          .select('id, name, price, total_tickets, tickets_sold, is_active')
          .eq('event_id', eventId)
          .eq('is_active', true)
          .order('sort_order');

        if (!types || types.length === 0) return true; // No types — use event-level price
        ctx.session.session_data._ticket_types = types;
        return false;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const types = ctx.session.session_data._ticket_types as Array<{ id: string; name: string; price: number; total_tickets: number; tickets_sold: number }>;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;

        return [{
          type: 'list',
          title: 'Ticket Types',
          body: 'Select your ticket type:',
          buttonLabel: 'View Options',
          items: types.map(t => {
            const available = t.total_tickets - t.tickets_sold;
            return {
              title: t.name,
              description: `${formatCurrency(t.price, cc)} • ${available} left`,
              postbackText: t.id,
            };
          }),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const types = ctx.session.session_data._ticket_types as Array<{ id: string; name: string; price: number; total_tickets: number; tickets_sold: number }>;
        const selected = types?.find(t => t.id === input);
        if (!selected) return { valid: false, errorMessage: 'Please select a ticket type from the list.' };

        const available = selected.total_tickets - selected.tickets_sold;
        if (available <= 0) return { valid: false, errorMessage: `Sorry, ${selected.name} tickets are sold out.` };

        return {
          valid: true,
          data: {
            ticket_type_id: selected.id,
            ticket_type_name: selected.name,
            event_price: selected.price, // Override event-level price
            event_available: available,
          },
        };
      },
      async next() { return 'select_quantity'; },
    },

    // ── Select Quantity ──
    {
      id: 'select_quantity',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const available = d.event_available as number;
        const eventMax = d.event_max_per_order as number | null;
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const bizMax = (meta.max_ticket_quantity as number) || 10;
        const maxTickets = eventMax || bizMax;
        const maxShow = Math.min(available, maxTickets);

        const messages: PromptMessage[] = [];

        const eventDetails = [
          `*${d.event_name}*`,
          `${new Date((d.event_date as string) + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { weekday: 'long', day: 'numeric', month: 'long' })}`,
          d.event_venue ? `${d.event_venue}` : '',
          `${formatCurrency(d.event_price as number, (ctx.business?.country_code || 'NG') as CountryCode)} per ticket`,
          `${available} tickets available`,
        ].filter(Boolean).join('\n');

        // Show event flyer with details as caption, or details as text if no image
        if (d.event_image_url) {
          messages.push({
            type: 'image' as const,
            imageUrl: d.event_image_url as string,
            caption: eventDetails,
          });
        } else {
          messages.push({ type: 'text', text: eventDetails });
        }

        messages.push(
          {
            type: 'buttons',
            body: `How many tickets? (max ${maxShow})`,
            buttons: [
              { id: '1', title: '1 ticket' },
              ...(maxShow >= 2 ? [{ id: '2', title: '2 tickets' }] : []),
              ...(maxShow >= 4 ? [{ id: '4', title: '4 tickets' }] : []),
            ].slice(0, 3), // WhatsApp max 3 buttons
          },
        );

        return messages;
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const qty = parseInt(input, 10);
        const available = ctx.session.session_data.event_available as number;

        if (isNaN(qty) || qty < 1) {
          return { valid: false, errorMessage: 'Please enter a valid number.' };
        }
        if (qty > available) {
          return { valid: false, errorMessage: `Only ${available} tickets available.` };
        }
        const eventMax = ctx.session.session_data.event_max_per_order as number | null;
        const meta = (ctx.session.session_data._biz_metadata || ctx.business?.metadata || {}) as Record<string, unknown>;
        const bizMax = (meta.max_ticket_quantity as number) || 10;
        const maxTickets = eventMax || bizMax;
        if (qty > maxTickets) {
          return { valid: false, errorMessage: `Maximum ${maxTickets} tickets per order.` };
        }

        const total = qty * (ctx.session.session_data.event_price as number);
        return { valid: true, data: { ticket_quantity: qty, total_amount: total } };
      },
      async next() { return 'ticket_confirmation'; },
    },

    // ── Confirmation ──
    {
      id: 'ticket_confirmation',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const dateLabel = new Date((d.event_date as string) + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), {
          weekday: 'long', day: 'numeric', month: 'long',
        });

        return [
          {
            type: 'text',
            text: [
              `📋 *Ticket Summary*`,
              '',
              `🎪 ${d.event_name}`,
              `📅 ${dateLabel}`,
              d.event_venue ? `📍 ${d.event_venue}` : '',
              `🎟️ ${d.ticket_quantity} ticket${(d.ticket_quantity as number) > 1 ? 's' : ''}`,
              `💰 Total: ${formatCurrency(d.total_amount as number, (ctx.business?.country_code || 'NG') as CountryCode)}`,
            ].filter(Boolean).join('\n'),
          },
          {
            type: 'buttons',
            body: 'Confirm purchase?',
            buttons: [
              { id: 'confirm', title: 'Confirm ✓' },
              { id: 'go_back', title: 'Cancel' },
            ],
          },
        ];
      },
      async validate(input: string): Promise<ValidationResult> {
        if ((input.toLowerCase() === 'cancel' || input.toLowerCase() === 'go_back')) return { valid: true, data: { _action: 'cancel' } };
        if (input.toLowerCase() === 'confirm') return { valid: true, data: { _action: 'confirm' } };
        return { valid: false, errorMessage: 'Please tap *Confirm* or *Cancel*.' };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._action === 'cancel') return null;
        return 'collect_name';
      },
    },

    // ── Collect Name ──
    {
      id: 'collect_name',
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: 'Please type your *full name* for the ticket:' }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const parts = input.trim().split(/\s+/);
        if (!parts[0] || parts[0].length < 2) {
          return { valid: false, errorMessage: 'Please enter a valid name.' };
        }
        return { valid: true, data: { first_name: parts[0], last_name: parts.slice(1).join(' ') || '' } };
      },
      async next() { return 'process_tickets'; },
      async skipIf(ctx: FlowContext) {
        if (ctx.session.user_id) {
          const user = await findUserByPhone(ctx.supabase, ctx.from);
          if (user?.first_name) {
            ctx.session.session_data.first_name = user.first_name;
            ctx.session.session_data.last_name = user.last_name;
            return true;
          }
        }
        return false;
      },
    },

    // ── Process Tickets ──
    {
      id: 'process_tickets',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const qty = d.ticket_quantity as number;
        const total = d.total_amount as number;

        // ── T&C gate ──
        if (!d._terms_accepted && total > 0 && ctx.business?.metadata?.require_terms_before_payment !== false) {
          await ctx.supabase.from('bot_sessions')
            .update({ session_data: d })
            .eq('id', ctx.session.id);
          return getTermsPrompt(ctx.business?.name || 'Events', (ctx.business?.metadata as Record<string, unknown>)?.terms_text as string | undefined);
        }
        if (d._terms_cancelled) {
          await ctx.supabase.from('bot_sessions')
            .update({ current_step: 'complete', is_active: false })
            .eq('id', ctx.session.id);
          return [{ type: 'text', text: 'No problem! Your ticket purchase has been cancelled. Send *Hi* to start over.' }];
        }

        // Ensure user exists
        let userId = ctx.session.user_id;
        if (!userId) {
          userId = await createWhatsAppUser(ctx.supabase, ctx.from, (d.first_name as string) || '', (d.last_name as string) || '');
          if (userId) {
            ctx.session.user_id = userId;
            await ctx.supabase.from('bot_sessions').update({ user_id: userId }).eq('id', ctx.session.id);
          }
        }
        if (!userId) return [{ type: 'text', text: 'Something went wrong. Send *Hi* to try again.' }];

        // Create booking for ticket
        const { data: booking, error } = await ctx.supabase
          .from('bookings')
          .insert({
            business_id: ctx.business!.id,
            user_id: userId,
            date: d.event_date as string,
            time: (d.event_time as string) || '00:00',
            party_size: qty,
            flow_type: 'ticketing',
            channel: 'whatsapp',
            deposit_amount: total,
            deposit_status: total > 0 ? 'pending' : 'none',
            status: total > 0 ? 'pending' : 'confirmed',
            total_amount: total,
            quantity: qty,
            guest_name: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
            guest_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
            notes: `Tickets for: ${d.event_name}`,
          })
          .select('id, reference_code')
          .single();

        if (error || !booking) {
          return [{ type: 'text', text: 'Something went wrong. Send *Hi* to try again.' }];
        }

        // Update tickets_sold
        const { error: rpcError } = await ctx.supabase.rpc('increment_tickets_sold', {
          event_id: d.event_id as string,
          qty,
        });

        if (rpcError) {
          // Fallback: manual increment
          const { data: ev } = await ctx.supabase
            .from('events')
            .select('tickets_sold')
            .eq('id', d.event_id as string)
            .single();
          if (ev) {
            await ctx.supabase
              .from('events')
              .update({ tickets_sold: ev.tickets_sold + qty })
              .eq('id', d.event_id as string);
          }
        }

        // Increment tickets_sold on the ticket type if one was selected
        if (d.ticket_type_id) {
          const { data: tt } = await ctx.supabase
            .from('event_ticket_types')
            .select('tickets_sold')
            .eq('id', d.ticket_type_id as string)
            .single();
          if (tt) {
            await ctx.supabase
              .from('event_ticket_types')
              .update({ tickets_sold: (tt.tickets_sold || 0) + qty })
              .eq('id', d.ticket_type_id as string);
          }
        }

        d.booking_id = booking.id;
        d.reference_code = booking.reference_code;
        // Platform fee is recorded after payment is verified in await_ticket_payment

        const dateLabel = new Date((d.event_date as string) + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), {
          weekday: 'long', day: 'numeric', month: 'long',
        });

        if (total > 0) {
          const paymentResult = await initializePayment(ctx.supabase, {
            bookingId: booking.id,
            userId,
            amount: total,
            referenceCode: booking.reference_code,
            businessName: ctx.business?.name || 'Events',
            phone: ctx.from,
            countryCode: (ctx.business?.country_code || 'NG') as CountryCode,
            businessId: ctx.business?.id,
          });

          if (paymentResult) {
            d.payment_reference = paymentResult.reference;
            await ctx.supabase
              .from('bot_sessions')
              .update({ session_data: d, current_step: 'await_ticket_payment' })
              .eq('id', ctx.session.id);

            return [
              {
                type: 'text',
                text: `🎫 *Tickets Reserved!*\n\n🎪 ${d.event_name}\n📅 ${dateLabel}\n🎟️ ${qty} ticket${qty > 1 ? 's' : ''}\n💰 ${formatCurrency(total, (ctx.business?.country_code || 'NG') as CountryCode)}\n🔑 Ref: *${booking.reference_code}*\n\n💳 Pay here 👇\n${paymentResult.url}\n\n⚠️ After paying, *return to WhatsApp* and tap *I've Paid* to confirm.`,
              },
              {
                type: 'buttons',
                body: "After paying, return here and tap *I've Paid* to confirm:",
                buttons: [
                  { id: 'i_paid', title: "I've Paid" },
                  { id: 'go_back', title: 'Cancel' },
                ],
              },
            ];
          }
        }

        // Free event — send tickets before marking complete
        try {
          await sendTicketsAfterPurchase({
          supabase: ctx.supabase,
          sender: ctx.sender,
          businessId: ctx.business!.id,
          bookingId: booking.id,
          eventId: d.event_id as string,
          eventName: d.event_name as string,
          eventDate: dateLabel,
          eventTime: d.event_time as string | undefined,
          venue: (d.event_venue as string) || '',
          guestName: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
          guestPhone: ctx.from,
          referenceCode: booking.reference_code,
          quantity: qty,
        });
        } catch (err) {
          console.error('[TICKETING] Ticket PDF send error:', err);
        }

        // Notify owner: email + WhatsApp
        notifyOwnerNewTicketSale({
          supabase: ctx.supabase,
          sender: ctx.sender,
          businessId: ctx.business!.id,
          businessName: ctx.business!.name,
          countryCode: (ctx.business?.country_code || 'NG') as CountryCode,
          referenceCode: booking.reference_code,
          customerName: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
          eventName: d.event_name as string,
          quantity: qty,
          ticketTypeName: d.ticket_type_name as string | undefined,
          totalAmount: total,
        }).catch(err => console.error('[TICKETING] Notify error:', err));

        // In-app notification
        createNotification(ctx.supabase, {
          businessId: ctx.business!.id,
          bookingId: booking.id,
          type: 'ticket_sale',
          channel: 'whatsapp',
          body: `New ticket sale: ${qty} ticket${qty > 1 ? 's' : ''} for ${d.event_name}. Ref: ${booking.reference_code}`,
        }).catch(err => console.error('[TICKETING] Notification error:', err));

        await ctx.supabase
          .from('bot_sessions')
          .update({ current_step: 'complete', is_active: false })
          .eq('id', ctx.session.id);

        return [{
          type: 'text',
          text: getTicketConfirmationMessage({
            eventName: d.event_name as string,
            dateLabel,
            venue: (d.event_venue as string) || '',
            quantity: qty,
            totalAmount: total,
            referenceCode: booking.reference_code,
          }),
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input === 'accept_terms') {
          return { valid: true, data: { _terms_accepted: true } };
        }
        if (input === 'cancel_terms') {
          return { valid: true, data: { _terms_cancelled: true } };
        }
        return { valid: true };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._terms_accepted || ctx.session.session_data._terms_cancelled) {
          return 'process_tickets';
        }
        return null;
      },
    },

    // ── Await Ticket Payment ──
    {
      id: 'await_ticket_payment',
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: "Complete payment using the link above.\n\nAfter paying, *return to WhatsApp* and tap *I've Paid* to confirm:",
          buttons: [
            { id: 'i_paid', title: "I've Paid" },
            { id: 'go_back', title: 'Cancel' },
          ],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const text = input.toLowerCase();

        if ((text === 'cancel' || text === 'go_back')) {
          const bookingId = ctx.session.session_data.booking_id as string;
          if (bookingId) {
            await ctx.supabase
              .from('bookings')
              .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
              .eq('id', bookingId);
          }
          await ctx.sender.sendText({ to: ctx.from, text: `Ticket purchase from *${ctx.business?.name || 'business'}* cancelled. Send *Hi* to start again.` });
          return { valid: true, data: { _action: 'cancel' } };
        }

        if (text === 'i_paid' || text === 'paid' || text === 'done') {
          const ref = ctx.session.session_data.payment_reference as string;
          if (!ref) return { valid: true, data: { _action: 'cancel' } };

          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          const verified = await verifyPayment(ctx.supabase, ref, cc);
          if (verified) {
            const d = ctx.session.session_data;
            const dateLabel = new Date((d.event_date as string) + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), {
              weekday: 'long', day: 'numeric', month: 'long',
            });
            await ctx.sender.sendText({
              to: ctx.from,
              text: getTicketConfirmationMessage({
                eventName: d.event_name as string,
                dateLabel,
                venue: (d.event_venue as string) || '',
                quantity: d.ticket_quantity as number,
                totalAmount: d.total_amount as number,
                referenceCode: d.reference_code as string,
              }),
            });

            // Send ticket PDF (non-blocking)
            sendTicketsAfterPurchase({
              supabase: ctx.supabase,
              sender: ctx.sender,
              businessId: ctx.business!.id,
              bookingId: d.booking_id as string,
              eventId: d.event_id as string,
              eventName: d.event_name as string,
              eventDate: dateLabel,
              eventTime: d.event_time as string | undefined,
              venue: (d.event_venue as string) || '',
              guestName: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
              guestPhone: ctx.from,
              referenceCode: d.reference_code as string,
              quantity: d.ticket_quantity as number,
            }).catch(err => console.error('[TICKETING] Ticket PDF send error:', err));

            // Notify owner: email + WhatsApp
            notifyOwnerNewTicketSale({
              supabase: ctx.supabase,
              sender: ctx.sender,
              businessId: ctx.business!.id,
              businessName: ctx.business!.name,
              countryCode: (ctx.business?.country_code || 'NG') as CountryCode,
              referenceCode: d.reference_code as string,
              customerName: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
              eventName: d.event_name as string,
              quantity: d.ticket_quantity as number,
              ticketTypeName: d.ticket_type_name as string | undefined,
              totalAmount: d.total_amount as number,
            }).catch(err => console.error('[TICKETING] Notify error:', err));

            // In-app notification
            createNotification(ctx.supabase, {
              businessId: ctx.business!.id,
              bookingId: d.booking_id as string,
              type: 'ticket_sale',
              channel: 'whatsapp',
              body: `New ticket sale: ${d.ticket_quantity} ticket${(d.ticket_quantity as number) > 1 ? 's' : ''} for ${d.event_name}. Amount: ${formatCurrency(d.total_amount as number, (ctx.business?.country_code || 'NG') as CountryCode)}. Ref: ${d.reference_code}`,
            }).catch(err => console.error('[TICKETING] Notification error:', err));

            // Record platform fee only after payment is verified
            if (ctx.business) {
              const isInTrial = new Date(ctx.business.trial_ends_at) > new Date();
              recordPlatformFee(ctx.supabase, {
                businessId: ctx.business.id,
                bookingId: d.booking_id as string,
                transactionAmount: d.total_amount as number,
                tier: ctx.business.subscription_tier as SubscriptionTier,
                isInTrial,
              }).catch(err => console.error('[TICKETING] recordPlatformFee error:', err));
            }

            return { valid: true, data: { _action: 'payment_confirmed' } };
          }

          return { valid: false, errorMessage: "Payment not yet received. Please complete payment." };
        }

        return { valid: false, errorMessage: "Tap *I've Paid* or *Cancel*." };
      },
      async next() { return null; },
    },
  ],
};
