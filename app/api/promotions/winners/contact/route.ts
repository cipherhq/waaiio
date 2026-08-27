import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapabilityWithRole } from '@/lib/capabilities/api-guard';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { stripPlus } from '@/lib/utils/phone';

const WINNER_TEMPLATE_NAME = 'promo_winner_status_v1';
const WINNER_TEMPLATE_LANGUAGE = 'en_US';
const RATE_LIMIT_MINUTES = 10;

/**
 * POST /api/promotions/winners/contact
 *
 * Send a winner notification template to a promo winner's WhatsApp number.
 * Only owner/admin/manager can trigger. Phone is never returned in the response.
 * Rate-limited to one contact per redemption per 10 minutes.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const service = createServiceClient();
  const { businessId, campaignId, redemptionId } = body as {
    businessId?: string; campaignId?: string; redemptionId?: string;
  };

  if (!businessId || !campaignId || !redemptionId) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Owner/admin/manager only
  const guard = await requireCapabilityWithRole(service, {
    businessId, userId: user.id, capability: 'promo_verification', action: 'manage_existing',
    allowedRoles: ['owner', 'admin', 'manager'],
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  // Fetch winner redemption with phone (server-side only, never returned)
  const { data: redemption } = await service
    .from('promo_redemptions')
    .select('id, phone_e164, claim_reference, promo_code_id')
    .eq('id', redemptionId)
    .eq('campaign_id', campaignId)
    .eq('business_id', businessId)
    .eq('outcome', 'winner')
    .maybeSingle();

  if (!redemption) {
    return NextResponse.json({ error: 'Winner not found' }, { status: 404 });
  }

  // Fetch business name
  const { data: bizRecord } = await service
    .from('businesses')
    .select('name')
    .eq('id', businessId)
    .maybeSingle();
  const businessName = bizRecord?.name || 'Business';

  // Fetch campaign name
  const { data: campaign } = await service
    .from('promo_campaigns')
    .select('name')
    .eq('id', campaignId)
    .maybeSingle();
  const campaignName = campaign?.name || 'Promotion';

  // Fetch prize name via code -> prize_id
  let prizeName = 'Prize';
  if (redemption.promo_code_id) {
    const { data: codeRow } = await service
      .from('promo_campaign_codes')
      .select('prize_id')
      .eq('id', redemption.promo_code_id)
      .maybeSingle();
    if (codeRow?.prize_id) {
      const { data: prize } = await service
        .from('promo_prizes')
        .select('name')
        .eq('id', codeRow.prize_id)
        .maybeSingle();
      if (prize?.name) prizeName = prize.name;
    }
  }

  const claimReference = redemption.claim_reference || 'N/A';

  // Resolve WhatsApp channel
  const resolver = new ChannelResolver(service);
  const resolved = await resolver.resolveByBusinessId(businessId);

  if (!resolved?.sender || !resolved.sender.sendTemplate) {
    logger.error('[PROMO-CONTACT] No template-capable WhatsApp channel for business', businessId);
    return NextResponse.json({ error: 'WhatsApp template delivery unavailable for this business' }, { status: 503 });
  }

  // Check template readiness on resolved WABA
  const meta = resolved.cloud;
  if (!meta) {
    return NextResponse.json({
      error: 'template_not_ready',
      message: 'WhatsApp channel does not support template management.',
    }, { status: 503 });
  }

  try {
    const existing = await meta.getTemplates();
    const template = (existing.data || []).find(
      (t: { name: string; language: string; status?: string }) =>
        t.name === WINNER_TEMPLATE_NAME && t.language === WINNER_TEMPLATE_LANGUAGE,
    );

    if (!template || template.status !== 'APPROVED') {
      return NextResponse.json({
        error: 'template_not_ready',
        message: 'Winner contact template pending approval. This feature will be available once the template is approved.',
      }, { status: 503 });
    }
  } catch (err) {
    logger.error('[PROMO-CONTACT] Template status check failed:', err);
    return NextResponse.json({
      error: 'template_not_ready',
      message: 'Could not verify template status.',
    }, { status: 503 });
  }

  // Claim-before-send: INSERT pending row FIRST (rate limit via unique partial index)
  const { data: claimRow, error: claimError } = await service
    .from('promo_winner_contacts')
    .insert({
      redemption_id: redemptionId,
      business_id: businessId,
      campaign_id: campaignId,
      actor_id: user.id,
      template_name: WINNER_TEMPLATE_NAME,
      provider_message_id: null,
      delivery_status: 'pending',
      sent_at: null,
    })
    .select('id')
    .single();

  if (claimError) {
    // Unique partial index violation means rate limited
    if (claimError.code === '23505') {
      return NextResponse.json({
        error: 'rate_limited',
        message: 'Winner was contacted recently. Please wait before contacting again.',
      }, { status: 429 });
    }
    logger.error('[PROMO-CONTACT] Failed to claim winner contact slot:', claimError);
    return NextResponse.json({ error: 'Failed to initiate winner contact.' }, { status: 500 });
  }

  // Send template message
  let messageId: string | undefined;
  let sendFailed = false;
  try {
    const phone = stripPlus(redemption.phone_e164);
    const result = await resolved.sender.sendTemplate({
      to: phone,
      templateName: WINNER_TEMPLATE_NAME,
      templateParams: [businessName, campaignName, prizeName, claimReference],
    });
    messageId = result?.messageId;
  } catch (err) {
    logger.error('[PROMO-CONTACT] WhatsApp template delivery failed:', err);
    sendFailed = true;
  }

  // UPDATE the claimed row with delivery result
  const { error: updateError } = await service
    .from('promo_winner_contacts')
    .update({
      provider_message_id: messageId || null,
      delivery_status: sendFailed ? 'failed' : 'sent',
      sent_at: sendFailed ? null : new Date().toISOString(),
    })
    .eq('id', claimRow.id);

  if (updateError) {
    logger.error('[PROMO-CONTACT] Failed to update winner contact delivery status:', updateError);
  }

  if (sendFailed) {
    return NextResponse.json({ error: 'Failed to send winner notification. Please try again.' }, { status: 503 });
  }

  // Never return phone in response
  return NextResponse.json({ sent: true, contact_id: undefined });
}
