import { createServiceClient } from '@/lib/supabase/service';
import { initCapabilities } from '@/lib/capabilities/service';
import { logger } from '@/lib/logger';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import type { CapabilityId } from '@/lib/capabilities/types';
import type { CountryCode } from '@/lib/constants';

/**
 * Process a completed WhatsApp Flows onboarding submission.
 *
 * Creates: auth user, business, whatsapp_config, capabilities, profile update.
 * Sends: welcome email + WhatsApp confirmation.
 */
export async function handleOnboardingComplete(
  flowToken: string,
  data: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  const customerPhone = flowToken.split(':')[1] || '';

  const firstName = (data.first_name as string || '').trim();
  const lastName = (data.last_name as string || '').trim();
  const email = (data.email as string || '').trim().toLowerCase();
  const password = data.password as string || '';
  const businessName = (data.business_name as string || '').trim();
  const category = (data.category as string || 'other');
  const country = (data.country as string || 'NG') as CountryCode;
  const city = (data.city as string || '').trim();
  const capabilities = (data.capabilities as string[] || ['scheduling']);

  if (!firstName || !email || !password || !businessName) {
    return { success: false, error: 'Missing required fields' };
  }

  const supabase = createServiceClient();

  try {
    // 1. Create user via admin API (skip email confirmation — WhatsApp verified)
    let userId: string;
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName },
    });

    if (authErr) {
      // If user exists, try to find them
      if (authErr.message?.includes('already been registered') || authErr.message?.includes('already exists')) {
        const { data: existing } = await supabase
          .from('profiles')
          .select('id')
          .eq('email', email)
          .single();
        if (existing) {
          userId = existing.id;
        } else {
          return { success: false, error: 'Email already registered. Please log in at waaiio.com' };
        }
      } else {
        logger.error('[WA-ONBOARD] Auth error:', authErr);
        return { success: false, error: 'Failed to create account' };
      }
    } else {
      userId = authData.user.id;
    }

    // 2. Check business count limit (prevent abuse — same as web onboarding)
    const { count: bizCount } = await supabase
      .from('businesses')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', userId);
    if ((bizCount || 0) >= 20) {
      return { success: false, error: 'Maximum number of businesses reached (20).' };
    }

    // 3. Generate slug and bot_code with collision handling
    const baseSlug = businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    let slug = baseSlug;
    let botCode = businessName
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 20);

    for (let i = 0; i < 5; i++) {
      const suffix = i > 0 ? `-${Math.random().toString(36).slice(2, 6)}` : '';
      const trySlug = baseSlug + suffix;
      const tryCode = botCode + (i > 0 ? suffix.replace('-', '').toUpperCase() : '');

      const { data: collision } = await supabase
        .from('businesses')
        .select('id')
        .or(`slug.eq.${trySlug},bot_code.eq.${tryCode}`)
        .limit(1)
        .maybeSingle();

      if (!collision) {
        slug = trySlug;
        botCode = tryCode;
        break;
      }
    }

    // 4. Determine flow_type from category
    const GIVING_CATEGORIES = ['church', 'mosque', 'school', 'ngo', 'crowdfunding_org'];
    const flowType = GIVING_CATEGORIES.includes(category) ? 'payment' : 'scheduling';

    // 5. Create business
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 30);

    const { data: biz, error: bizErr } = await supabase
      .from('businesses')
      .insert({
        owner_id: userId,
        name: businessName,
        slug,
        bot_code: botCode,
        category,
        flow_type: flowType,
        country_code: country,
        city,
        address: city,
        phone: customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`,
        wa_method: 'shared',
        subscription_tier: 'free',
        status: 'active',
        trial_ends_at: trialEnd.toISOString(),
        verification_level: 'unverified',
      })
      .select('id, name, bot_code')
      .single();

    if (bizErr || !biz) {
      logger.error('[WA-ONBOARD] Business creation error:', bizErr);
      return { success: false, error: 'Failed to create business' };
    }

    // 6. Create WhatsApp config with default greeting
    try {
      await supabase
        .from('whatsapp_config')
        .insert({
          business_id: biz.id,
          greeting_template: `Welcome to ${businessName}! How can I help you today?`,
          confirmation_template: [
            `✅ Your booking at ${businessName} is confirmed!`,
            `📅 {{date}} at {{time}}`,
            `👥 {{quantity}} {{quantityLabel}}`,
            `🔑 Ref: {{reference_code}}`,
          ].join('\n'),
        });
    } catch {
      // Non-critical — config can be set later from dashboard
    }

    // 7. Initialize capabilities
    const capIds = capabilities.map(c => c as CapabilityId);
    await initCapabilities(supabase, biz.id, category, capIds).catch(err => {
      logger.error('[WA-ONBOARD] Capability init error:', err);
    });

    // 8. Update profile
    try {
      await supabase
        .from('profiles')
        .update({
          first_name: firstName,
          last_name: lastName,
          role: 'restaurant_owner',
          phone: customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`,
        })
        .eq('id', userId);
    } catch {
      // Non-critical — profile can be updated later
    }

    // 9. Send welcome email (non-blocking)
    try {
      const { sendEmail } = await import('@/lib/email/client');
      await sendEmail({
        to: email,
        subject: `Welcome to Waaiio — ${businessName} is live!`,
        html: [
          `<p>Hi ${firstName},</p>`,
          `<p>Your business <strong>${businessName}</strong> is now set up on Waaiio!</p>`,
          `<p><strong>Dashboard:</strong> <a href="https://www.waaiio.com/dashboard">waaiio.com/dashboard</a></p>`,
          `<p><strong>Bot Code:</strong> ${biz.bot_code}</p>`,
          `<p><strong>Login:</strong> ${email}</p>`,
          `<p>Your 30-day free trial is active — explore all features!</p>`,
          `<p style="color:#999;font-size:12px">Powered by Waaiio</p>`,
        ].join(''),
      });
    } catch {
      // Email failure is non-critical
    }

    // 10. Send WhatsApp confirmation (non-blocking)
    try {
      const resolver = new ChannelResolver(supabase);
      const resolved = await resolver.getSharedChannelForCountry(country);
      if (resolved) {
        const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
        await resolved.sender.sendText({
          to: phone,
          text: [
            `✅ *${businessName} is live on Waaiio!*`,
            '',
            'Your business is set up and ready to go.',
            '',
            `📱 *Dashboard:* https://www.waaiio.com/dashboard`,
            `🔑 *Bot Code:* ${biz.bot_code}`,
            `📧 *Login:* ${email}`,
            '',
            'Your 30-day free trial includes all features.',
            '',
            '_Need help? Type *help* anytime._',
          ].join('\n'),
        });
      }
    } catch (err) {
      logger.error('[WA-ONBOARD] Confirmation message error:', err);
    }

    return { success: true };
  } catch (err) {
    logger.error('[WA-ONBOARD] Onboarding error:', err);
    return { success: false, error: 'Internal error' };
  }
}
