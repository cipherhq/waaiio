import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { logger } from '@/lib/logger';

const PICKUP_TEMPLATE_NAME = 'promo_pickup_verification';

type TemplateReadiness = 'ready' | 'pending' | 'provisioning_required' | 'rejected' | 'unavailable' | 'shared_waba';

/**
 * GET /api/promotions/template-status?businessId=...
 *
 * Returns the readiness status of the Secure Pickup verification template
 * for a specific business. Does NOT call Meta to create/modify templates.
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

  // Look up dedicated channel
  const { data: channel } = await service
    .from('whatsapp_channels')
    .select('waba_id, meta_access_token, provider')
    .eq('business_id', businessId)
    .eq('provider', 'meta_cloud')
    .eq('is_active', true)
    .maybeSingle();

  if (!channel?.waba_id || !channel?.meta_access_token) {
    // Shared WABA — template must be pre-provisioned on the shared WABA
    // We cannot check status without the shared WABA credentials
    return NextResponse.json({
      template: PICKUP_TEMPLATE_NAME,
      status: 'shared_waba' as TemplateReadiness,
      message: 'Business uses shared WhatsApp. Template readiness depends on shared WABA configuration.',
    });
  }

  try {
    const meta = new MetaCloudService({
      accessToken: channel.meta_access_token,
      phoneNumberId: '',
      wabaId: channel.waba_id,
    });

    const existing = await meta.getTemplates();
    const template = (existing.data || []).find(
      (t) => t.name === PICKUP_TEMPLATE_NAME && t.language === 'en_US',
    );

    if (!template) {
      return NextResponse.json({
        template: PICKUP_TEMPLATE_NAME,
        status: 'provisioning_required' as TemplateReadiness,
        message: 'Template not yet created. Enable Promotions capability to auto-provision.',
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
    });
  } catch (err) {
    logger.error('[PROMO-TEMPLATE] Status check failed:', err);
    return NextResponse.json({
      template: PICKUP_TEMPLATE_NAME,
      status: 'unavailable' as TemplateReadiness,
      message: 'Could not check template status.',
    });
  }
}
