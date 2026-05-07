import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { formatCurrency, type CountryCode } from '@/lib/constants';

const selectCampaignStep: FlowStepConfig = {
  id: 'select_campaign',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    if (!ctx.business) return [{ type: 'text', text: 'Business not found.' }];

    const today = new Date().toISOString().split('T')[0];
    const { data: campaigns } = await ctx.supabase
      .from('campaigns')
      .select('id, title, description, goal_amount, raised_amount, donor_count, end_date')
      .eq('business_id', ctx.business.id)
      .eq('status', 'active')
      .or(`end_date.is.null,end_date.gte.${today}`)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!campaigns || campaigns.length === 0) {
      return [{ type: 'text', text: 'No active campaigns at the moment. Please check back later!' }];
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
        return {
          title: c.title,
          description: `${formatCurrency(c.raised_amount, country)} raised (${progress}%) - ${c.donor_count} donors`,
          postbackText: `campaign_${c.id}`,
        };
      }),
    }];
  },

  async validate(input: string, ctx: FlowContext) {
    if (!input.startsWith('campaign_')) {
      return { valid: false, errorMessage: 'Please select a campaign from the list.' };
    }

    const campaignId = input.replace('campaign_', '');
    const { data: campaign } = await ctx.supabase
      .from('campaigns')
      .select('id, title, goal_amount, raised_amount, donor_count, min_donation, max_donation')
      .eq('id', campaignId)
      .single();

    if (!campaign) {
      return { valid: false, errorMessage: 'Campaign not found. Please try again.' };
    }

    return {
      valid: true,
      data: {
        campaign_id: campaign.id,
        campaign_title: campaign.title,
        campaign_goal: campaign.goal_amount,
        campaign_raised: campaign.raised_amount,
        campaign_donors: campaign.donor_count,
        campaign_min_donation: campaign.min_donation,
        campaign_max_donation: campaign.max_donation,
      },
    };
  },

  async next() {
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
    const filled = Math.round((progress / 100) * barLength);
    const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

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

    return [{ type: 'text', text: `How much would you like to donate? ${hint}` }];
  },

  async validate(input: string, ctx: FlowContext) {
    const amount = Math.round(parseFloat(input.replace(/[^0-9.]/g, '')) * 100) / 100;
    const cc = (ctx.business?.country_code || 'NG') as CountryCode;
    const sd = ctx.session.session_data;
    const minDonation = (sd.campaign_min_donation as number) || 1;
    const maxDonation = (sd.campaign_max_donation as number) || null;

    if (!amount || isNaN(amount) || amount < minDonation) {
      return { valid: false, errorMessage: `Please enter a valid amount (minimum ${formatCurrency(minDonation, cc)}).` };
    }
    if (maxDonation && amount > maxDonation) {
      return { valid: false, errorMessage: `Maximum donation for this campaign is ${formatCurrency(maxDonation, cc)}.` };
    }
    return { valid: true, data: { donation_amount: amount } };
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
      body: `Donate ${formatCurrency(sd.donation_amount as number, country)} to *${sd.campaign_title}*?\n\nYou'll receive a payment link.`,
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

    // Generate reference
    const refCode = `DON-${Date.now().toString(36).toUpperCase()}`;

    // Resolve donor name from profile if available
    let donorName = '';
    if (ctx.session.user_id) {
      const { data: profile } = await ctx.supabase
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', ctx.session.user_id)
        .maybeSingle();
      if (profile?.first_name) {
        donorName = `${profile.first_name} ${profile.last_name || ''}`.trim();
      }
    }

    // Initialize payment
    const { initializePayment } = await import('./shared/payment');
    const result = await initializePayment(ctx.supabase, {
      userId: ctx.session.user_id || '',
      amount,
      referenceCode: refCode,
      businessName: ctx.business?.name || '',
      phone: ctx.from,
      countryCode: country,
      businessId: ctx.business?.id,
      campaignId: sd.campaign_id as string,
      donorName,
    });

    if (!result) {
      return [{ type: 'text', text: 'Sorry, we could not create a payment link. Please try again later.' }];
    }

    // Store reference for verification
    sd.payment_reference = result.reference;
    sd.donation_ref_code = refCode;
    sd.donor_name = donorName;
    await ctx.supabase
      .from('bot_sessions')
      .update({ session_data: sd, current_step: 'await_donation_payment' })
      .eq('id', ctx.session.id);

    return [
      {
        type: 'text',
        text: [
          `Thank you for your generosity! \ud83d\ude4f`,
          '',
          `*Campaign:* ${sd.campaign_title}`,
          `*Amount:* ${formatCurrency(amount, country)}`,
          `*Ref:* ${refCode}`,
          '',
          `Pay here \ud83d\udc47`,
          result.url,
          '',
          `\u26a0\ufe0f After paying, *return to WhatsApp* and tap *I've Paid* to confirm.`,
        ].join('\n'),
      },
      {
        type: 'buttons',
        body: "After paying, return here and tap *I've Paid* to confirm:",
        buttons: [
          { id: 'i_paid', title: "I've Paid" },
          { id: 'cancel', title: 'Cancel' },
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

  async prompt(): Promise<PromptMessage[]> {
    return [{
      type: 'buttons',
      body: "Complete your donation using the link above.\n\nAfter paying, *return to WhatsApp* and tap *I've Paid* to confirm:",
      buttons: [
        { id: 'i_paid', title: "I've Paid" },
        { id: 'cancel', title: 'Cancel' },
      ],
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const text = input.toLowerCase();

    if (text === 'cancel') {
      // Mark donation as cancelled
      const refCode = ctx.session.session_data.donation_ref_code as string;
      if (refCode) {
        await ctx.supabase
          .from('campaign_donations')
          .update({ status: 'cancelled' })
          .eq('reference_code', refCode);
      }
      await ctx.sender.sendText({ to: ctx.from, text: 'Donation cancelled. Send *Hi* to start again.' });
      return { valid: true, data: { _action: 'cancel' } };
    }

    if (text === 'i_paid' || text === 'paid' || text === 'done' || text === 'check') {
      const ref = ctx.session.session_data.payment_reference as string;
      if (!ref) return { valid: true, data: { _action: 'cancel' } };

      const cc = (ctx.business?.country_code || 'NG') as CountryCode;
      const { verifyPayment } = await import('./shared/payment');
      const verified = await verifyPayment(ctx.supabase, ref, cc);

      if (verified) {
        const sd = ctx.session.session_data;
        const amount = sd.donation_amount as number;
        const campaignId = sd.campaign_id as string;
        const refCode = sd.donation_ref_code as string;

        // Update donation record status
        if (refCode) {
          await ctx.supabase
            .from('campaign_donations')
            .update({ status: 'confirmed' })
            .eq('reference_code', refCode);
        }

        // Update campaign raised_amount and donor_count
        if (campaignId) {
          const { data: campaign } = await ctx.supabase
            .from('campaigns')
            .select('raised_amount, donor_count')
            .eq('id', campaignId)
            .single();

          if (campaign) {
            await ctx.supabase
              .from('campaigns')
              .update({
                raised_amount: (campaign.raised_amount || 0) + amount,
                donor_count: (campaign.donor_count || 0) + 1,
              })
              .eq('id', campaignId);
          }
        }

        // Send confirmation
        await ctx.sender.sendText({
          to: ctx.from,
          text: [
            `\u2705 *Donation Confirmed!*`,
            '',
            `\ud83d\ude4f Thank you for supporting *${sd.campaign_title}*`,
            `\ud83d\udcb0 Amount: ${formatCurrency(amount, cc)}`,
            `\ud83d\udd11 Ref: *${refCode}*`,
            '',
            `Your generosity makes a difference! \u2764\ufe0f`,
          ].join('\n'),
        });

        return { valid: true, data: { _action: 'payment_confirmed' } };
      }

      return { valid: false, errorMessage: "Payment not yet received. Please complete payment using the link." };
    }

    return { valid: false, errorMessage: "Tap *I've Paid* or *Cancel*." };
  },

  async next() {
    return null; // Flow complete after confirmation or cancel
  },
};

export const crowdfundingFlow: FlowDefinition = {
  type: 'payment', // Uses payment infrastructure
  steps: [
    selectCampaignStep,
    campaignViewStep,
    enterDonationAmountStep,
    confirmDonationStep,
    donationPaymentStep,
    awaitDonationPaymentStep,
  ],
};
