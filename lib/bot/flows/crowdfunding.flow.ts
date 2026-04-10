import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage } from './types';
import { formatCurrency, type CountryCode } from '@/lib/constants';

const selectCampaignStep: FlowStepConfig = {
  id: 'select_campaign',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    if (!ctx.business) return [{ type: 'text', text: 'Business not found.' }];

    const { data: campaigns } = await ctx.supabase
      .from('campaigns')
      .select('id, title, description, goal_amount, raised_amount, donor_count')
      .eq('business_id', ctx.business.id)
      .eq('status', 'active')
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
      .select('id, title, goal_amount, raised_amount, donor_count')
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

  async prompt(): Promise<PromptMessage[]> {
    return [{ type: 'text', text: 'How much would you like to donate? Enter the amount:' }];
  },

  async validate(input: string) {
    const amount = parseInt(input.replace(/[^0-9]/g, ''), 10);
    if (!amount || amount < 100) {
      return { valid: false, errorMessage: 'Please enter a valid amount (minimum 100).' };
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
    });

    if (!result) {
      return [{ type: 'text', text: 'Sorry, we could not create a payment link. Please try again later.' }];
    }

    return [{
      type: 'text',
      text: [
        `Thank you for your generosity! 🙏`,
        '',
        `*Campaign:* ${sd.campaign_title}`,
        `*Amount:* ${formatCurrency(amount, country)}`,
        `*Ref:* ${refCode}`,
        '',
        `Pay here: ${result.url}`,
        '',
        `⚠️ After paying, *return to WhatsApp*.`,
        '',
        `Your donation will be reflected once payment is confirmed.`,
      ].join('\n'),
    }];
  },

  async validate() {
    return { valid: true, data: {} };
  },

  async next() {
    return null; // Flow complete
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
  ],
};
