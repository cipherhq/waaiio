import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { logger } from '@/lib/logger';

const PICKUP_TEMPLATE_NAME = 'promo_pickup_verification';
const PICKUP_V2_TEMPLATE_NAME = 'promo_pickup_verification_v2';
const WINNER_TEMPLATE_NAME = 'promo_winner_status_v1';
const TEMPLATE_LANGUAGE = 'en_US';

export type TemplateReadiness = 'ready' | 'pending' | 'provisioning_required' | 'rejected' | 'unavailable';

/**
 * GET /api/promotions/template-status?businessId=...
 *
 * Returns the readiness status of the Secure Pickup verification template
 * on the EFFECTIVE send channel (the same WABA that ChannelResolver would
 * use for actual OTP delivery). Does NOT create/modify templates.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get('businessId');
  if (!businessId) return NextResponse.json({ error: 'businessId is required' }, { status: 400 });

  const service = createServiceClient();
  const guard = await requireCapability(supabase, service, {
    businessId, userId: user.id, capability: 'promo_verification', action: 'read_history',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  // Resolve the EFFECTIVE send channel — same path as actual OTP delivery
  const resolver = new ChannelResolver(service);
  const resolved = await resolver.resolveByBusinessId(businessId);

  if (!resolved) {
    return NextResponse.json({
      template: PICKUP_TEMPLATE_NAME,
      status: 'unavailable' as TemplateReadiness,
      message: 'No WhatsApp channel available for this business.',
      managed: false,
    });
  }

  const channel = resolved.channel;
  const isBusinessOwned = channel.channel_type === 'dedicated' && channel.business_id === businessId;

  // Reuse the resolver's effective Meta client — same decrypted credentials
  // and WABA that would be used for actual OTP delivery
  const meta = resolved.cloud;
  if (!meta) {
    return NextResponse.json({
      template: PICKUP_TEMPLATE_NAME,
      status: 'unavailable' as TemplateReadiness,
      message: 'WhatsApp channel does not support template management.',
      managed: !isBusinessOwned,
    });
  }

  try {
    const existing = await meta.getTemplates();
    const allTemplates = existing.data || [];

    // Helper to resolve readiness for a single template name
    function resolveTemplate(templateName: string): { status: TemplateReadiness; meta_status?: string; message: string } {
      const template = allTemplates.find(
        (t: { name: string; language: string; status?: string }) =>
          t.name === templateName && t.language === TEMPLATE_LANGUAGE,
      );

      if (!template) {
        return {
          status: 'provisioning_required',
          message: isBusinessOwned
            ? 'Template not yet created. Enable Promotions capability to auto-provision.'
            : 'Template not yet available on the managed WhatsApp channel. Contact support.',
        };
      }

      const metaStatus = template.status || 'UNKNOWN';
      switch (metaStatus) {
        case 'APPROVED':
          return { status: 'ready', meta_status: metaStatus, message: 'Template is approved and ready.' };
        case 'PENDING':
          return { status: 'pending', meta_status: metaStatus, message: 'Template is awaiting Meta approval.' };
        case 'REJECTED':
          return { status: 'rejected', meta_status: metaStatus, message: 'Template was rejected by Meta. Re-provisioning may be needed.' };
        default:
          return { status: 'unavailable', meta_status: metaStatus, message: `Template status: ${metaStatus}.` };
      }
    }

    const pickupV1 = resolveTemplate(PICKUP_TEMPLATE_NAME);
    const pickupV2 = resolveTemplate(PICKUP_V2_TEMPLATE_NAME);
    const winnerStatus = resolveTemplate(WINNER_TEMPLATE_NAME);

    return NextResponse.json({
      templates: {
        [PICKUP_TEMPLATE_NAME]: { template: PICKUP_TEMPLATE_NAME, ...pickupV1 },
        [PICKUP_V2_TEMPLATE_NAME]: { template: PICKUP_V2_TEMPLATE_NAME, ...pickupV2 },
        [WINNER_TEMPLATE_NAME]: { template: WINNER_TEMPLATE_NAME, ...winnerStatus },
      },
      // Backward compat: top-level fields use pickup v1 for existing callers
      template: PICKUP_TEMPLATE_NAME,
      status: pickupV1.status,
      meta_status: pickupV1.meta_status,
      message: pickupV1.message,
      managed: !isBusinessOwned,
    });
  } catch (err) {
    logger.error('[PROMO-TEMPLATE] Status check failed:', err);
    return NextResponse.json({
      template: PICKUP_TEMPLATE_NAME,
      status: 'unavailable' as TemplateReadiness,
      message: 'Could not check template status.',
      managed: !isBusinessOwned,
    });
  }
}
