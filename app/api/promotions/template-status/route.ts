import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { logger } from '@/lib/logger';

const PICKUP_TEMPLATE_NAME = 'promo_pickup_verification';
const PICKUP_TEMPLATE_LANGUAGE = 'en_US';

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
    const template = (existing.data || []).find(
      (t) => t.name === PICKUP_TEMPLATE_NAME && t.language === PICKUP_TEMPLATE_LANGUAGE,
    );

    if (!template) {
      return NextResponse.json({
        template: PICKUP_TEMPLATE_NAME,
        status: 'provisioning_required' as TemplateReadiness,
        message: isBusinessOwned
          ? 'Template not yet created. Enable Promotions capability to auto-provision.'
          : 'Template not yet available on the managed WhatsApp channel. Contact support.',
        managed: !isBusinessOwned,
      });
    }

    const metaStatus = template.status || 'UNKNOWN';
    let readiness: TemplateReadiness;
    let message: string;

    switch (metaStatus) {
      case 'APPROVED':
        readiness = 'ready';
        message = 'Secure Pickup verification template is approved and ready.';
        break;
      case 'PENDING':
        readiness = 'pending';
        message = 'Template is awaiting Meta approval. Secure Pickup will be available once approved.';
        break;
      case 'REJECTED':
        readiness = 'rejected';
        message = 'Template was rejected by Meta. Re-provisioning may be needed.';
        break;
      default:
        readiness = 'unavailable';
        message = `Template status: ${metaStatus}. Secure Pickup is not available.`;
    }

    return NextResponse.json({
      template: PICKUP_TEMPLATE_NAME,
      status: readiness,
      meta_status: metaStatus,
      message,
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
