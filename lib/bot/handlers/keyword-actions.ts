import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { logger } from '@/lib/logger';
import type { BotIntelligenceService } from '../bot-intelligence';
import type { StandaloneService } from '../standalone.service';
import type { FlowExecutor } from '../flows/executor';
import type { BotSession, BotContext, BusinessRecord } from '../bot-types';
import type { CapabilityId } from '@/lib/capabilities/types';
import { getEnabledCapabilities } from '@/lib/capabilities/service';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { getPoweredByFooter, getPoweredByHtml } from '@/lib/whitelabel';
import type { UnifiedKeyword } from '../keyword-service';
import { parseKeywordPayload } from '../keyword-service';
import { capabilityToFirstStep } from './flow-routing';
import { handleTransactionDocument } from './transaction-docs';
import { handleMyBookings } from './my-bookings';

/**
 * Execute the action from a unified keyword match.
 * Returns true if the action was handled, false to continue to flow executor.
 *
 * @param onRestart - Callback for recursive handleMessage (used by 'start_flow' action).
 */
export async function executeKeywordAction(
  ctx: BotContext,
  from: string,
  session: BotSession,
  kw: UnifiedKeyword,
  onRestart: (from: string, text: string, type: string, dest?: string, bizId?: string) => Promise<void>,
): Promise<boolean> {
  const { supabase, messageSender, standaloneService, intelligence, flowExecutor } = ctx;
  const payload = parseKeywordPayload(kw.payload);
  const step = session.current_step;

  const sendText = async (to: string, text: string) => {
    try {
      logger.debug('[BOT] sendText to:', to, 'text:', text.slice(0, 100));
      const result = await messageSender.sendText({ to, text });
      logger.debug('[BOT] sendText result:', JSON.stringify(result));
    } catch (err) {
      logger.error('[BOT] sendText FAILED to:', to, 'error:', err);
    }
  };

  const deactivateSession = async (sessionId: string) => {
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', sessionId);
  };

  try {
    switch (kw.action_type) {
      case 'reply': {
        const message = (payload.message as string) || kw.payload;
        await sendText(from, message);
        return true;
      }

      case 'acknowledge': {
        const message = (payload.message as string) || "You're welcome! Is there anything else I can help with?";
        intelligence.resetAbuse(from);
        await sendText(from, message);
        return true;
      }

      case 'show_menu': {
        const menuType = payload.message as string;
        if (menuType === 'greeting') {
          // Treat as restart — deactivate and re-greet
          await deactivateSession(session.id);
          return false; // Let the restart logic handle it
        }
        // Generic menu — show help
        const isStandalone = !!session.business_id;
        const businessName = session.session_data.business_name as string | undefined;
        let alias: string | null = null;
        if (isStandalone && session.business_id) {
          alias = await standaloneService.getBotAlias(session.business_id);
        }
        await sendText(from, intelligence.getHelpText(isStandalone, businessName, alias || undefined));
        return true;
      }

      case 'navigate_step': {
        const action = payload.action as string;
        intelligence.resetAbuse(from);

        if (action === 'show_status' || action === 'show_history') {
          // Bookings / history
          await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
          const phoneP = from.startsWith('+') ? from : `+${from}`;
          const phoneN = from.startsWith('+') ? from.slice(1) : from;
          const { data: profile } = await supabase.from('profiles').select('id').or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`).limit(1).maybeSingle();
          if (!profile?.id) {
            await sendText(from, "I don't have an account for this number. Send *Hi* to start over.");
            return true;
          }
          if (action === 'show_history') {
            await handleTransactionDocument(supabase, messageSender, sendText, from, profile.id, 'history');
            return true;
          }
          // show_status -> my_bookings
          const { data: newSession } = await supabase.from('bot_sessions').insert({
            whatsapp_number: from, user_id: profile.id, business_id: null,
            current_step: 'my_bookings', session_data: {}, is_active: true,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          }).select().single();
          if (!newSession) { await sendText(from, 'Something went wrong.'); return true; }
          await handleMyBookings(supabase, messageSender, sendText, flowExecutor, newSession as BotSession, from, '');
          return true;
        }

        if (action === 'show_receipt') {
          await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
          const phoneP = from.startsWith('+') ? from : `+${from}`;
          const phoneN = from.startsWith('+') ? from.slice(1) : from;
          const { data: profile } = await supabase.from('profiles').select('id').or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`).limit(1).maybeSingle();
          if (!profile?.id) {
            await sendText(from, "I don't have an account for this number. Send *Hi* to start over.");
            return true;
          }
          await handleTransactionDocument(supabase, messageSender, sendText, from, profile.id, 'receipt');
          return true;
        }

        if (action === 'show_pricing') {
          await sendText(from, 'Pricing varies by service. Start a booking to see current prices!');
          const nudge = intelligence.getContextualHelp(step);
          await sendText(from, nudge);
          return true;
        }

        if (action === 'escalate') {
          if (session.business_id) {
            const caps = (session.session_data?.capabilities as CapabilityId[]) || await getEnabledCapabilities(supabase, session.business_id);
            if (caps.includes('chat')) {
              const escPhoneP = from.startsWith('+') ? from : `+${from}`;
              const escPhoneN = from.startsWith('+') ? from.slice(1) : from;
              let escCustomerName: string | null = null;
              const { data: escProfile } = await supabase
                .from('profiles')
                .select('first_name, last_name')
                .or(`phone.eq.${sanitizeFilterValue(escPhoneP)},phone.eq.${sanitizeFilterValue(escPhoneN)}`)
                .limit(1)
                .maybeSingle();
              if (escProfile?.first_name) {
                escCustomerName = `${escProfile.first_name}${escProfile.last_name ? ' ' + escProfile.last_name : ''}`;
              }
              const businessName = (session.session_data.business_name as string) || 'the business';
              const { escalateToHuman } = await import('@/lib/bot/handoff.service');
              await escalateToHuman({
                supabase,
                sender: messageSender,
                from,
                businessId: session.business_id,
                businessName,
                sessionId: session.id,
                sessionData: session.session_data,
                currentStep: step,
                customerName: escCustomerName,
              });
              return true;
            }
          }
          await sendText(from, "Live chat isn't available for this business. Type *help* for other options.");
          return true;
        }

        if (action === 'checkin') {
          if (session.business_id) {
            const caps = (session.session_data?.capabilities as CapabilityId[]) || await getEnabledCapabilities(supabase, session.business_id);
            if (caps.includes('queue')) {
              await supabase.from('bot_sessions').update({
                current_step: 'queue_start',
                session_data: { ...session.session_data, active_capability: 'queue' },
              }).eq('id', session.id);
              session.current_step = 'queue_start';
              session.session_data.active_capability = 'queue';
              const { data: biz } = await supabase
                .from('businesses')
                .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
                .eq('id', session.business_id)
                .single();
              await flowExecutor.execute(from, '', session as unknown as BotSession, biz as BusinessRecord | null);
              return true;
            }
          }
          await sendText(from, "This business doesn't have queue check-in enabled.");
          return true;
        }

        // Unknown navigate_step action
        return false;
      }

      case 'url': {
        const message = (payload.message as string) || kw.payload;
        await sendText(from, message);
        return true;
      }

      case 'start_flow': {
        // Don't hijack active flows — only route from greeting/capability selection
        const isRoutingStepForFlow = !step || step === 'greeting' || step === 'select_capability';
        if (!isRoutingStepForFlow) return false;
        await deactivateSession(session.id);
        await onRestart(from, 'Hi', 'text', undefined, session.business_id || undefined);
        return true;
      }

      case 'start_capability': {
        const capability = (payload.capability as string) || kw.payload;
        // Don't hijack active flows — only route from greeting/capability selection
        const isRoutingStep = !step || step === 'greeting' || step === 'select_capability';
        if (!isRoutingStep) return false;
        if (session.business_id) {
          session.session_data.active_capability = capability;
          const capFirstStep = capabilityToFirstStep(capability as CapabilityId);
          await supabase.from('bot_sessions').update({
            current_step: capFirstStep,
            session_data: session.session_data,
          }).eq('id', session.id);
          session.current_step = capFirstStep;
          const { data: biz } = await supabase
            .from('businesses')
            .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
            .eq('id', session.business_id)
            .single();
          await flowExecutor.execute(from, '', session as unknown as BotSession, biz as BusinessRecord | null);
          return true;
        }
        return false;
      }

      case 'campaign_reply': {
        if (!kw.campaign_id) return false;

        // Load campaign
        const { data: campaign } = await supabase
          .from('keyword_campaigns')
          .select('*')
          .eq('id', kw.campaign_id)
          .single();

        if (!campaign || !campaign.is_active) return false;

        // Check date range (if set)
        const now = new Date();
        if (campaign.starts_at && new Date(campaign.starts_at) > now) return false;
        if (campaign.ends_at && new Date(campaign.ends_at) < now) return false;

        // Send response based on type
        switch (campaign.response_type) {
          case 'image':
            if (campaign.response_media_url) {
              await messageSender.sendImage({
                to: from,
                imageUrl: campaign.response_media_url,
                caption: campaign.response_text,
              });
            } else {
              await sendText(from, campaign.response_text);
            }
            break;

          case 'buttons': {
            // Parse buttons from payload: expects { buttons: [{ id, title }], body? }
            const btnPayload = parseKeywordPayload(kw.payload);
            const buttons = (btnPayload.buttons as Array<{ id: string; title: string }>) || [];
            if (buttons.length > 0) {
              await messageSender.sendButtons({
                to: from,
                body: campaign.response_text,
                buttons: buttons.slice(0, 3), // WhatsApp max 3 buttons
              });
            } else {
              await sendText(from, campaign.response_text);
            }
            break;
          }

          case 'text':
          case 'link':
          default:
            await sendText(from, campaign.response_text);
            break;
        }

        // Record response (upsert — ignore if already responded)
        await supabase
          .from('keyword_campaign_responses')
          .upsert(
            {
              campaign_id: kw.campaign_id,
              business_id: campaign.business_id,
              phone: from,
              responded_at: new Date().toISOString(),
            },
            { onConflict: 'campaign_id,phone', ignoreDuplicates: true },
          );

        // Upsert customer_profiles: opt-in for notifications
        await supabase
          .from('customer_profiles')
          .upsert(
            {
              phone: from,
              business_id: campaign.business_id,
              notification_opt_in: true,
            },
            { onConflict: 'phone,business_id', ignoreDuplicates: false },
          );

        // Send opt-in follow-up if configured
        if (campaign.opt_in_message) {
          await sendText(from, campaign.opt_in_message);
        }

        // Notify owner about keyword campaign response (email + WhatsApp)
        {
          const [{ count: responseCount }, { data: kwBiz }] = await Promise.all([
            supabase.from('keyword_campaign_responses').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id),
            supabase.from('businesses').select('subscription_tier').eq('id', campaign.business_id).single(),
          ]);
          const kwTier = kwBiz?.subscription_tier || null;
          const { notifyOwnerGeneric } = await import('../flows/shared/notify-owner');
          notifyOwnerGeneric({
            supabase,
            sender: messageSender,
            businessId: campaign.business_id,
            subject: `Keyword hit: ${kw.keyword}`,
            emailHtml: `<p>${from} texted "${kw.keyword}". You now have ${responseCount || 1} response${(responseCount || 1) === 1 ? '' : 's'}.</p><p>View results in your dashboard.</p>${getPoweredByHtml(kwTier)}`,
            whatsappText: `🔑 *Keyword Hit*\n\n${from} texted "${kw.keyword}".\nTotal responses: ${responseCount || 1}\n\nView results in your dashboard.${getPoweredByFooter(kwTier)}`,
          }).catch(() => {});
        }

        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    logger.error('[BOT] executeKeywordAction error (non-fatal):', err);
    return false;
  }
}
