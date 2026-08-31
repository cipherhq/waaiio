import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { formatCurrency, getCurrencyCode, type CountryCode } from '@/lib/constants';
import { analyzeReceipt, receiptMatchesExpected } from '@/lib/bot/receipt-ocr';
import { parseIvePaidInput, isIvePaidInput } from '@/lib/bot/flows/shared/ive-paid-input';
import { checkBankTransferEligibility, createPendingTransfer, formatBankTransferBlock, BANK_ONLY_BUTTONS } from './shared/bank-transfer';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { notifyOwnerNewDonation } from './shared/notify-owner';
import { createNotification } from './shared/notifications';
import { checkTierLimit } from '@/lib/tier-limits';
// handlePostCompletion and recordPlatformFee removed from I've Paid path (#173)
// Stage 2 (processSuccessfulPayment) and Stage 3 (sendProactiveConfirmation) now own these effects
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { getPoweredByFooter } from '@/lib/whitelabel';
import { buildListItem } from '../utils/truncate';
import { isToggleColumnMissing } from '@/lib/utils/campaign-column-fallback';

const EXPANDED_CAMPAIGN_SELECT = 'id, title, description, goal_amount, raised_amount, donor_count, end_date, allow_after_end_date, allow_after_goal_met' as const;
const LEGACY_CAMPAIGN_SELECT = 'id, title, description, goal_amount, raised_amount, donor_count, end_date' as const;

const selectCampaignStep: FlowStepConfig = {
  id: 'select_campaign',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    if (!ctx.business) return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];

    const today = new Date().toISOString().split('T')[0];

    // Try expanded select including donation-continuation toggles (Migration 199).
    // If the toggle columns don't exist yet, fall back to legacy select.
    // The ?? true fallback in the filter below defaults both toggles to "allow"
    // (preserving current behaviour for pre-migration databases).
    let { data: allCampaigns, error: queryError } = await ctx.supabase
      .from('campaigns')
      .select(EXPANDED_CAMPAIGN_SELECT)
      .eq('business_id', ctx.business.id)
      .eq('status', 'active')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(20);

    if (queryError) {
      if (isToggleColumnMissing(queryError)) {
        // Migration 199 not applied — retry without toggle columns
        const legacy = await ctx.supabase
          .from('campaigns')
          .select(LEGACY_CAMPAIGN_SELECT)
          .eq('business_id', ctx.business.id)
          .eq('status', 'active')
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(20);
        if (legacy.error) {
          logger.withContext({ op: 'crowdfunding.select-campaign', ...safeLogErrorContext(legacy.error) })
            .error('[CROWDFUNDING] Legacy campaign query failed');
          return [{ type: 'text', text: 'Something went wrong loading campaigns. Please try again shortly.' }];
        }
        allCampaigns = legacy.data as typeof allCampaigns;
      } else {
        // Unrelated error (auth, RLS, network, etc.) — do not show "no campaigns"
        logger.withContext({ op: 'crowdfunding.select-campaign', ...safeLogErrorContext(queryError) })
          .error('[CROWDFUNDING] Campaign query failed');
        return [{ type: 'text', text: 'Something went wrong loading campaigns. Please try again shortly.' }];
      }
    }

    // Filter: exclude campaigns past end date or that met their goal.
    // When toggle columns are absent (legacy fallback), ?? true preserves
    // current behaviour — all donations allowed.
    const campaigns = (allCampaigns || []).filter(c => {
      const allowAfterEnd = (c as Record<string, unknown>).allow_after_end_date ?? true;
      const allowAfterGoal = (c as Record<string, unknown>).allow_after_goal_met ?? true;
      if (c.end_date && c.end_date < today && !allowAfterEnd) return false;
      if (c.goal_amount > 0 && c.raised_amount >= c.goal_amount && !allowAfterGoal) return false;
      return true;
    }).slice(0, 10);

    if (!campaigns || campaigns.length === 0) {
      return [{
        type: 'buttons',
        body: 'No active campaigns at the moment.',
        buttons: [
          { id: 'go_back', title: 'Back to Menu' },
        ],
      }];
    }

    const country = (ctx.business.country_code || 'NG') as CountryCode;

    return [{
      type: 'list',
      title: 'Active Campaigns',
      body: 'Select a campaign to support:',
      buttonLabel: 'View Campaigns',
      items: campaigns.map(c => {
        const progress = c.goal_amount > 0
          ? Math.round((c.raised_amount / c.goal_amount) * 100)
          : 0;
        const desc = `${formatCurrency(c.raised_amount, country)} raised (${progress}%) - ${c.donor_count} donors`;
        return {
          ...buildListItem({ name: c.title, postbackText: `campaign_${c.id}` }),
          description: desc.slice(0, 72),
        };
      }),
    }];
  },

  async validate(input: string, ctx: FlowContext) {
    if (input === 'go_back') {
      return { valid: true, data: { _campaign_action: 'back_to_menu' } };
    }

    if (!input.startsWith('campaign_')) {
      return { valid: false, errorMessage: 'I didn\'t find that campaign. Tap an option from the list above.' };
    }

    const campaignId = input.replace('campaign_', '');
    const { data: campaign, error } = await ctx.supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();

    if (error || !campaign) {
      return { valid: false, errorMessage: 'Campaign not found. Please tap one of the options above.' };
    }

    // Re-check eligibility (campaign state may have changed)
    const todayStr = new Date().toISOString().split('T')[0];
    const allowAfterEnd = (campaign as Record<string, unknown>).allow_after_end_date ?? true;
    const allowAfterGoal = (campaign as Record<string, unknown>).allow_after_goal_met ?? true;
    if (campaign.end_date && campaign.end_date < todayStr && !allowAfterEnd) {
      return { valid: false, errorMessage: 'This campaign has ended and is no longer accepting donations.' };
    }
    if (campaign.goal_amount > 0 && campaign.raised_amount >= campaign.goal_amount && !allowAfterGoal) {
      return { valid: false, errorMessage: 'This campaign has reached its goal and is no longer accepting donations. Thank you!' };
    }

    return {
      valid: true,
      data: {
        campaign_id: campaign.id,
        campaign_title: campaign.title,
        campaign_goal: campaign.goal_amount,
        campaign_raised: campaign.raised_amount,
        campaign_donors: campaign.donor_count,
        campaign_min_donation: campaign.min_donation ?? null,
        campaign_max_donation: campaign.max_donation ?? null,
        campaign_allow_after_goal_met: allowAfterGoal,
      },
    };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data._campaign_action === 'back_to_menu') {
      delete ctx.session.session_data._campaign_action;
      return 'select_capability';
    }
    return 'campaign_view';
  },
};

const campaignViewStep: FlowStepConfig = {
  id: 'campaign_view',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const sd = ctx.session.session_data;
    const country = (ctx.business?.country_code || 'NG') as CountryCode;
    const goal = sd.campaign_goal as number;
    const raised = sd.campaign_raised as number;
    const donors = sd.campaign_donors as number;
    const progress = goal > 0 ? Math.round((raised / goal) * 100) : 0;

    // Text progress bar
    const barLength = 20;
    const filled = Math.min(barLength, Math.round((Math.min(progress, 100) / 100) * barLength));
    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barLength - filled));

    const message = [
      `*${sd.campaign_title}*`,
      '',
      `${bar} ${progress}%`,
      `${formatCurrency(raised, country)} of ${formatCurrency(goal, country)} goal`,
      `${donors} donor${donors !== 1 ? 's' : ''}`,
    ].join('\n');

    return [
      { type: 'text', text: message },
      {
        type: 'buttons',
        body: 'Would you like to donate?',
        buttons: [
          { id: 'donate_yes', title: 'Donate Now' },
          { id: 'donate_back', title: 'Back to Campaigns' },
        ],
      },
    ];
  },

  async validate(input: string) {
    if (input === 'donate_yes') return { valid: true, data: {} };
    if (input === 'donate_back') return { valid: true, data: { go_back: true } };
    return { valid: false, errorMessage: 'Please select an option.' };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data.go_back) {
      delete ctx.session.session_data.go_back;
      return 'select_campaign';
    }
    return 'enter_donation_amount';
  },
};

const enterDonationAmountStep: FlowStepConfig = {
  id: 'enter_donation_amount',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const cc = (ctx.business?.country_code || 'NG') as CountryCode;
    const sd = ctx.session.session_data;
    const minDonation = (sd.campaign_min_donation as number) || null;
    const maxDonation = (sd.campaign_max_donation as number) || null;

    let hint = 'Enter the amount:';
    if (minDonation && maxDonation) {
      hint = `Enter an amount between ${formatCurrency(minDonation, cc)} and ${formatCurrency(maxDonation, cc)}:`;
    } else if (minDonation) {
      hint = `Enter the amount (minimum ${formatCurrency(minDonation, cc)}):`;
    } else if (maxDonation) {
      hint = `Enter the amount (maximum ${formatCurrency(maxDonation, cc)}):`;
    }

    return [{ type: 'text', text: `How much would you like to donate? ${hint}\n\n_Type *cancel* to go back._` }];
  },

  async validate(input: string, ctx: FlowContext) {
    // Escape hatch: allow user to go back or cancel
    const lower = input.toLowerCase().trim();
    if (lower === 'cancel' || lower === 'back' || lower === 'exit') {
      return { valid: true, data: { _donation_back: true } };
    }

    const amount = Math.round(parseFloat(input.replace(/[^0-9.]/g, '')) * 100) / 100;
    const cc = (ctx.business?.country_code || 'NG') as CountryCode;
    const sd = ctx.session.session_data;
    const minDonation = (sd.campaign_min_donation as number) || 1;
    const maxDonation = (sd.campaign_max_donation as number) || null;

    if (!amount || isNaN(amount) || amount < minDonation) {
      return { valid: false, errorMessage: `Please enter a valid amount (minimum ${formatCurrency(minDonation, cc)}).` };
    }
    // Platform-wide hard cap (prevents accidental huge entries)
    const platformMax = 10_000_000;
    const effectiveMax = maxDonation ? Math.min(maxDonation, platformMax) : platformMax;
    if (amount > effectiveMax) {
      return { valid: false, errorMessage: maxDonation
        ? `Maximum donation for this campaign is ${formatCurrency(maxDonation, cc)}.`
        : `Maximum amount is ${formatCurrency(platformMax, cc)}.` };
    }

    // Re-check goal in case it was reached while user was typing
    if (sd.campaign_allow_after_goal_met === false) {
      const { data: fresh } = await ctx.supabase
        .from('campaigns')
        .select('raised_amount, goal_amount')
        .eq('id', sd.campaign_id as string)
        .single();
      if (fresh && fresh.goal_amount > 0 && fresh.raised_amount >= fresh.goal_amount) {
        return { valid: false, errorMessage: 'This campaign just reached its goal and is no longer accepting donations. Thank you!' };
      }
    }

    return { valid: true, data: { donation_amount: amount } };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data._donation_back) {
      delete ctx.session.session_data._donation_back;
      return 'campaign_view';
    }
    return 'enter_donor_name';
  },
};

const enterDonorNameStep: FlowStepConfig = {
  id: 'enter_donor_name',

  async skipIf(ctx: FlowContext): Promise<boolean> {
    // Skip if user already has a profile with a name
    if (ctx.session.user_id) {
      const { data: profile } = await ctx.supabase
        .from('profiles')
        .select('first_name')
        .eq('id', ctx.session.user_id)
        .maybeSingle();
      if (profile?.first_name) {
        ctx.session.session_data.donor_display_name = `${profile.first_name}`;
        return true;
      }
    }
    return false;
  },

  async prompt(): Promise<PromptMessage[]> {
    return [{
      type: 'buttons',
      body: 'What name should we display for your donation?',
      buttons: [
        { id: 'donate_anonymous', title: 'Stay Anonymous' },
      ],
    }];
  },

  async validate(input: string) {
    if (input === 'donate_anonymous') {
      return { valid: true, data: { donor_display_name: null } };
    }
    const name = input.trim();
    if (!name || name.length < 2) {
      return { valid: false, errorMessage: 'Please enter your name or tap *Stay Anonymous*.' };
    }
    return { valid: true, data: { donor_display_name: name } };
  },

  async next() {
    return 'confirm_donation';
  },
};

const confirmDonationStep: FlowStepConfig = {
  id: 'confirm_donation',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const sd = ctx.session.session_data;
    const country = (ctx.business?.country_code || 'NG') as CountryCode;

    return [{
      type: 'buttons',
      body: `Donate ${formatCurrency(sd.donation_amount as number, country)} to *${sd.campaign_title}*?`,
      buttons: [
        { id: 'confirm_yes', title: 'Confirm' },
        { id: 'confirm_cancel', title: 'Cancel' },
      ],
    }];
  },

  async validate(input: string) {
    if (input === 'confirm_yes') return { valid: true, data: {} };
    if (input === 'confirm_cancel') return { valid: true, data: { cancelled: true } };
    return { valid: false, errorMessage: 'Please tap Confirm or Cancel.' };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data.cancelled) {
      await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('Donation cancelled. Send *Hi* to start over.') });
      return null; // End flow
    }
    return 'donation_payment';
  },
};

const donationPaymentStep: FlowStepConfig = {
  id: 'donation_payment',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const sd = ctx.session.session_data;
    const amount = sd.donation_amount as number;
    const country = (ctx.business?.country_code || 'NG') as CountryCode;

    // CAP-001 Point C: Verify CURRENT capability before CREATE_NEW donation
    if (ctx.business) {
      const { requireCurrentCapability } = await import('./shared/capability-guard');
      const capGuard = await requireCurrentCapability(ctx.supabase, {
            session: { id: ctx.session.id, version: ctx.session.version, session_data: ctx.session.session_data },
        businessId: ctx.business.id,
        capability: 'crowdfunding',
        action: 'create_new',
      });
      if (!capGuard.allowed) { if (capGuard.recoveryStatus === 'stale') return [];
        return [{ type: 'text' as const, text: await ctx.t(capGuard.customerMessage) }];
      }
    }

    // ── Tier limit check for giving/donations ──
    if (ctx.business) {
      const tierResult = await checkTierLimit(
        ctx.supabase,
        ctx.business.id,
        'giving',
        ctx.business.subscription_tier,
      );
      if (!tierResult.allowed) {
        return [{ type: 'text', text: await ctx.t('This account has reached its monthly limit. Please contact the business owner.') }];
      }
      if (tierResult.softBlock) {
        createNotification(ctx.supabase, {
          businessId: ctx.business.id,
          type: 'tier_limit_warning',
          channel: 'in_app',
          subject: 'Donation limit approaching',
          body: `You've received ${tierResult.current}/${tierResult.limit} donations this month. Upgrade for more.`,
        }).catch(err => logger.withContext({ op: 'crowdfunding.tier-limit-notify', ...safeLogErrorContext(err) }).error('[CROWDFUNDING] Failed to create tier limit notification'));
      }
    }

    // Generate reference
    const refCode = `DON-${Date.now().toString(36).toUpperCase()}`;

    // Use name from the donor name step (or profile if skipped)
    const donorName = (sd.donor_display_name as string) || '';

    // Initialize payment
    const { initializePayment } = await import('./shared/payment');
    const result = await initializePayment(ctx.supabase, {
      userId: ctx.session.user_id || '',
      amount,
      referenceCode: refCode,
      businessName: ctx.business?.name || '',
      phone: ctx.from,
      countryCode: country,
      gatewayOverride: ctx.business?.payment_gateway || null,
      businessId: ctx.business?.id,
      campaignId: sd.campaign_id as string,
      donorName,
      inboundChannelId: ctx.session.session_data._inbound_channel_id as string | undefined,
      confirmationOrigin: 'whatsapp' as const,
    });

    // Store reference for verification
    sd.donation_ref_code = refCode;
    sd.donor_name = donorName;

    // Check if business qualifies for direct bank transfer
    const { qualifies: _btQualifies, bankAccount, platformSettings: ps } = await checkBankTransferEligibility(ctx.supabase, {
      businessId: ctx.business!.id,
      countryCode: country,
      subscriptionTier: ctx.business?.subscription_tier || 'free',
      amount,
    });

    if (!result) {
      // Payment gateway failed — but bank transfer may still be available
      if (bankAccount) {
        const transferRef = await createPendingTransfer(ctx.supabase, {
          businessId: ctx.business!.id,
          entityId: { campaign_id: sd.campaign_id as string },
          customerPhone: ctx.from,
          customerName: donorName || 'Anonymous',
          amount,
          countryCode: country,
          transferExpiryHours: ps.transfer_expiry_hours,
        });
        sd.bank_transfer_reference = transferRef;
        sd.bank_transfer_offered = true;
        sd.bank_transfer_amount = amount;

        await ctx.supabase
          .from('bot_sessions')
          .update({ session_data: sd, current_step: 'await_donation_payment' })
          .eq('id', ctx.session.id);

        return [
          {
            type: 'text',
            text: [
              `🏦 *Bank Transfer Payment*`,
              '',
              `*Campaign:* ${sd.campaign_title}`,
              `*Amount:* ${formatCurrency(amount, country)}`,
              `*Ref:* ${refCode}`,
              '',
              `Transfer to:`,
              formatBankTransferBlock(bankAccount, formatCurrency(amount, country), transferRef),
            ].join('\n'),
          },
          {
            type: 'buttons',
            body: 'Tap below after transferring:',
            buttons: [...BANK_ONLY_BUTTONS],
          },
        ];
      }

      return [{ type: 'text', text: 'Sorry, we could not create a payment link. Please try again later.' }];
    }

    // Gateway succeeded — store payment reference
    sd.payment_reference = result.reference;

    if (bankAccount) {
      // Dual-option: online + bank transfer
      const transferRef = await createPendingTransfer(ctx.supabase, {
        businessId: ctx.business!.id,
        entityId: { campaign_id: sd.campaign_id as string },
        customerPhone: ctx.from,
        customerName: donorName || 'Anonymous',
        amount,
        countryCode: country,
        transferExpiryHours: ps.transfer_expiry_hours,
      });
      sd.bank_transfer_reference = transferRef;
      sd.bank_transfer_offered = true;
      sd.bank_transfer_amount = amount;

      await ctx.supabase
        .from('bot_sessions')
        .update({ session_data: sd, current_step: 'await_donation_payment' })
        .eq('id', ctx.session.id);

      return [
        {
          type: 'text',
          text: [
            `Thank you for your generosity! 🙏`,
            '',
            `*Campaign:* ${sd.campaign_title}`,
            `*Amount:* ${formatCurrency(amount, country)}`,
            `*Ref:* ${refCode}`,
            '',
            `*Option 1 — Pay Online* 👇`,
            result.url,
            '',
            `*Option 2 — Bank Transfer* 🏦`,
            formatBankTransferBlock(bankAccount, formatCurrency(amount, country), transferRef),
          ].join('\n'),
        },
        {
          type: 'buttons',
          body: "After paying, tap below:",
          buttons: [
            { id: sd.payment_reference ? `i_paid_ref:${sd.payment_reference}` : 'i_paid_online', title: "I've Paid Online" },
            { id: 'sent_transfer', title: "I've Sent Transfer" },
            { id: 'go_back', title: 'Cancel' },
          ],
        },
      ];
    }

    // Standard online-only flow
    await ctx.supabase
      .from('bot_sessions')
      .update({ session_data: sd, current_step: 'await_donation_payment' })
      .eq('id', ctx.session.id);

    return [
      {
        type: 'text',
        text: [
          `Thank you for your generosity! 🙏`,
          '',
          `*Campaign:* ${sd.campaign_title}`,
          `*Amount:* ${formatCurrency(amount, country)}`,
          `*Ref:* ${refCode}`,
          '',
          `Pay here 👇`,
          result.url,
          '',
          `⚠️ Your confirmation will arrive automatically after payment.`,
        ].join('\n'),
      },
      {
        type: 'buttons',
        body: "Paid already? Tap below to confirm:",
        buttons: [
          { id: sd.payment_reference ? `i_paid_ref:${sd.payment_reference}` : 'i_paid', title: "I've Paid" },
          { id: 'go_back', title: 'Cancel' },
        ],
      },
    ];
  },

  async validate() {
    return { valid: true };
  },

  async next() {
    return 'await_donation_payment';
  },
};

const awaitDonationPaymentStep: FlowStepConfig = {
  id: 'await_donation_payment',
  acceptsMedia: true,

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const sd = ctx.session.session_data;
    const pRef = sd.payment_reference as string | undefined;
    if (sd.bank_transfer_offered) {
      return [{
        type: 'buttons',
        body: "Complete your donation using the link or bank transfer above.\n\nTap below after paying:",
        buttons: [
          { id: pRef ? `i_paid_ref:${pRef}` : 'i_paid_online', title: "I've Paid Online" },
          { id: 'sent_transfer', title: "I've Sent Transfer" },
          { id: 'go_back', title: 'Cancel' },
        ],
      }];
    }
    return [{
      type: 'buttons',
      body: "Complete your donation using the link above.\n\nPaid already? Tap below to confirm:",
      buttons: [
        { id: pRef ? `i_paid_ref:${pRef}` : 'i_paid', title: "I've Paid" },
        { id: 'go_back', title: 'Cancel' },
      ],
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const text = input.toLowerCase();
    const sd = ctx.session.session_data;

    if ((text === 'cancel' || text === 'go_back')) {
      // CAS guard: cancel donation only while still pending (#173)
      const refCode = sd.donation_ref_code as string;
      if (refCode) {
        const { data: cancelResult, error: cancelErr } = await ctx.supabase
          .from('campaign_donations')
          .update({ status: 'cancelled' })
          .eq('reference_code', refCode)
          .in('status', ['pending'])
          .select('id');

        if (cancelErr) {
          return { valid: false, errorMessage: 'Something went wrong. Please try again.' };
        }

        if (!cancelResult?.length) {
          const { data: don } = await ctx.supabase.from('campaign_donations')
            .select('status').eq('reference_code', refCode).maybeSingle();
          if (don?.status === 'success') {
            await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('✅ Your donation has already been confirmed! Thank you for your generosity.\n\n💡 Type *my giving* to see your giving history.') });
            return { valid: true, data: { _action: 'already_confirmed' } };
          }
          if (don?.status === 'cancelled') {
            // Already cancelled — treat as established
          } else {
            return { valid: false, errorMessage: 'Something went wrong. Please try again.' };
          }
        }

        if (sd.bank_transfer_reference) {
          await ctx.supabase
            .from('pending_transfers')
            .update({ status: 'cancelled' })
            .eq('reference_code', sd.bank_transfer_reference as string);
        }
      }
      await ctx.sender.sendText({ to: ctx.from, text: await ctx.t(`Donation to *${ctx.business?.name || 'organization'}* cancelled. Send *Hi* to start over.`) });
      return { valid: true, data: { _action: 'cancel' } };
    }

    // ── Bank transfer proof: image uploaded ──
    if (ctx.mediaType === 'image' && ctx.mediaUrl && sd.bank_transfer_reference) {
      const transferRef = sd.bank_transfer_reference as string;
      const expectedAmount = sd.bank_transfer_amount as number;
      const cc = (ctx.business?.country_code || 'NG') as CountryCode;
      const currency = getCurrencyCode(cc);

      const ocr = await analyzeReceipt(ctx.mediaUrl, expectedAmount, transferRef, currency);
      const ocrMatches = receiptMatchesExpected(ocr, expectedAmount, transferRef);

      await ctx.supabase
        .from('pending_transfers')
        .update({
          proof_type: 'screenshot',
          proof_image_url: ctx.mediaUrl,
          verified_by_ocr: ocrMatches,
          ocr_result: ocrMatches ? { amount: ocr.amount, reference: ocr.reference, sender_name: ocr.senderName, bank_name: ocr.bankName, confidence: ocr.confidence } : null,
        })
        .eq('reference_code', transferRef)
        .eq('status', 'pending');

      if (ctx.business) {
        const donorName = (sd.donor_display_name as string) || 'Anonymous';
        notifyOwnerNewDonation({
          supabase: ctx.supabase,
          sender: ctx.sender,
          businessId: ctx.business.id,
          businessName: ctx.business.name,
          countryCode: cc,
          referenceCode: transferRef,
          donorName,
          amount: expectedAmount,
          campaignTitle: `${sd.campaign_title as string} (Bank Transfer)`,
        }).catch(err => logger.withContext({ op: 'crowdfunding.transfer-notify', ...safeLogErrorContext(err) }).error('[CROWDFUNDING] Transfer notify error'));

        createNotification(ctx.supabase, {
          businessId: ctx.business.id,
          type: 'transfer_proof_received',
          channel: 'whatsapp',
          body: `Transfer proof received from ${donorName} for ${formatCurrency(expectedAmount, cc)} donation. Ref: ${transferRef}. Confirm in Dashboard → Pending Transfers.`,
        }).catch(err => logger.withContext({ op: 'crowdfunding.transfer-notification', ...safeLogErrorContext(err) }).error('[CROWDFUNDING] Transfer notification error'));
      }

      const ocrHint = ocrMatches ? `\n\n🤖 _Our AI verified your receipt — amount and reference match._` : '';
      await ctx.sender.sendText({
        to: ctx.from,
        text: await ctx.t(`✅ Payment proof received. *${ctx.business?.name || 'The organization'}* will review and confirm your donation shortly.\n\nRef: *${transferRef}*${ocrHint}\n\nSend *Hi* to continue.`),
      });
      return { valid: true, data: { _action: 'transfer_proof_sent' } };
    }

    // ── "I've Sent Transfer" button ──
    if (text === 'sent_transfer' || text === "i've sent transfer" || text === 'i_sent_transfer') {
      if (!sd.bank_transfer_reference) {
        return { valid: false, errorMessage: 'No bank transfer reference found. Please use the online payment link instead.' };
      }
      sd._awaiting_transfer_proof = true;
      await ctx.supabase.from('bot_sessions').update({ session_data: sd }).eq('id', ctx.session.id);
      await ctx.sender.sendText({
        to: ctx.from,
        text: await ctx.t(`Please send a *screenshot* of your transfer receipt, or type the bank *transaction reference* so we can verify your payment.\n\nRef: *${sd.bank_transfer_reference}*`),
      });
      return { valid: false, errorMessage: '' };
    }

    // ── Text proof after tapping "I've Sent Transfer" ──
    if (sd._awaiting_transfer_proof && text && !isIvePaidInput(text)) {
      await ctx.supabase
        .from('pending_transfers')
        .update({ proof_type: 'text', proof_text: input.trim() })
        .eq('reference_code', sd.bank_transfer_reference as string)
        .eq('status', 'pending');

      await ctx.sender.sendText({
        to: ctx.from,
        text: await ctx.t(`✅ Transfer reference received. *${ctx.business?.name || 'The organization'}* will review and confirm your donation shortly.\n\nRef: *${sd.bank_transfer_reference}*\n\nSend *Hi* to continue.`),
      });
      return { valid: true, data: { _action: 'transfer_proof_sent' } };
    }

    const ivePaidResult = parseIvePaidInput(text);
    if (ivePaidResult.recognized) {
      const ref = ctx.session.session_data.payment_reference as string;

      // #219: If locator doesn't match active session reference, route through
      // recoverByPaymentReference — do NOT substitute the active session's reference.
      if (ivePaidResult.paymentRef && ref && ivePaidResult.paymentRef !== ref) {
        const { recoverByPaymentReference } = await import('@/lib/payments/stale-payment-recovery');
        const { data: recBiz } = await ctx.supabase.from('businesses')
          .select('country_code').eq('id', ctx.session.business_id).single();
        const cc = (recBiz?.country_code || 'NG') as import('@/lib/constants').CountryCode;
        const recoveryResult = await recoverByPaymentReference(
          { supabase: ctx.supabase, businessId: ctx.session.business_id!, userId: ctx.session.user_id || null, phone: ctx.from, countryCode: cc },
          ivePaidResult.paymentRef,
        );
        await ctx.sender.sendText({ to: ctx.from, text: recoveryResult.message });
        // #219: Keep active session at current step — do not end Payment B because of old Payment A button
        return { valid: false };
      }

      if (!ref) return { valid: false, errorMessage: "We couldn't verify your donation. If you've already paid, please contact the organization." };

      // Converge through canonical Payment Authority (#173)
      const { verifyAndReconcilePayment } = await import('@/lib/payments/bot-recovery');
      const recovery = await verifyAndReconcilePayment(ctx.supabase, ref);

      if (recovery.outcome === 'completed' || recovery.outcome === 'not_deliverable') {
        const sd = ctx.session.session_data;
        await ctx.sender.sendText({
          to: ctx.from,
          text: await ctx.t(`✅ *Donation Confirmed!*\n\n🙏 Thank you for supporting *${sd.campaign_title}*\n\n💡 Type *my giving* to see your giving history, or *receipt* for your donation receipt.`),
        });
        return { valid: true, data: { _action: 'already_confirmed' } };
      }

      if (recovery.outcome === 'processing' || recovery.outcome === 'retryable') {
        await ctx.sender.sendText({
          to: ctx.from,
          text: await ctx.t('✅ Donation received! Your donation is being processed.\n\nYou\'ll get a confirmation shortly. If not, tap *I\'ve Paid* again.'),
        });
        return { valid: true, data: { _action: 'payment_processing' } };
      }

      if (recovery.outcome === 'not_paid') {
        return { valid: false, errorMessage: "Payment not yet received. The link may have expired — tap *Get New Link* for a fresh one." };
      }

      if (recovery.outcome === 'provider_error') {
        return { valid: false, errorMessage: "We couldn't verify your donation right now. If you've already paid, tap *I've Paid* again in a moment." };
      }

      return { valid: false, errorMessage: 'Something went wrong. Please try again.' };
    }

    return { valid: false, errorMessage: "Tap *I've Paid* or *Cancel*." };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data._action === 'payment_processing') {
      return 'await_donation_payment';
    }
    return null;
  },
};

export const crowdfundingFlow: FlowDefinition = {
  type: 'payment', // Uses payment infrastructure
  steps: [
    selectCampaignStep,
    campaignViewStep,
    enterDonationAmountStep,
    enterDonorNameStep,
    confirmDonationStep,
    donationPaymentStep,
    awaitDonationPaymentStep,
  ],
};
