import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { MetaCloudService, type CreateTemplateInput } from '@/lib/channels/meta-cloud';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { logger } from '@/lib/logger';

function corsHeaders(origin?: string | null) {
  const allowedOrigins = [
    process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
    'http://localhost:8083',
  ];
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request.headers.get('origin')) });
}

function jsonWithCors(body: unknown, init?: { status?: number }, origin?: string | null) {
  return NextResponse.json(body, { ...init, headers: corsHeaders(origin) });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/whatsapp/templates?business_id=xxx
 *
 * Two authorized paths:
 * 1. Platform admin (no business_id) → manages shared WABA templates
 * 2. Business owner (with business_id) → reads their dedicated channel templates
 *
 * An owner without a dedicated channel gets the shared WABA read-only view.
 * This is the only path where an ordinary user may observe shared templates.
 */
export async function GET(request: NextRequest) {
  const origin = request.headers.get('origin');
  try {
    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get('business_id');

    // ── Path 1: Business owner reading templates ──
    if (businessId) {
      if (!UUID_RE.test(businessId)) {
        return jsonWithCors({ message: 'Invalid business_id' }, { status: 400 }, origin);
      }

      // Authenticate via cookie session
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        return jsonWithCors({ message: 'Unauthorized' }, { status: 401 }, origin);
      }

      // Verify business ownership
      const { data: business, error: bizError } = await supabase
        .from('businesses')
        .select('id, status')
        .eq('id', businessId)
        .eq('owner_id', user.id)
        .maybeSingle();

      if (bizError) {
        logger.error('[TEMPLATES] GET ownership check failed:', bizError.message);
        return jsonWithCors({ message: 'Authorization check failed' }, { status: 500 }, origin);
      }
      if (!business) {
        return jsonWithCors({ message: 'Forbidden' }, { status: 403 }, origin);
      }

      // Look up dedicated channel
      const service = createServiceClient();
      const { data: channel, error: channelError } = await service
        .from('whatsapp_channels')
        .select('waba_id, meta_access_token')
        .eq('business_id', businessId)
        .eq('provider', 'meta_cloud')
        .eq('is_active', true)
        .single();

      if (channelError && channelError.code !== 'PGRST116') {
        // PGRST116 = no rows found (legitimate absence) — anything else is a DB error
        logger.error('[TEMPLATES] GET channel lookup error:', channelError.message);
        return jsonWithCors({ message: 'Failed to look up channel' }, { status: 500 }, origin);
      }

      let meta: MetaCloudService;
      if (channel?.waba_id && channel?.meta_access_token) {
        meta = new MetaCloudService({ accessToken: channel.meta_access_token, phoneNumberId: '', wabaId: channel.waba_id });
      } else {
        // No dedicated channel — read-only shared WABA view (owner can see available templates)
        meta = new MetaCloudService();
      }

      const result = await meta.getTemplates();
      return jsonWithCors(result, undefined, origin);
    }

    // ── Path 2: Platform admin managing shared WABA ──
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) {
      return jsonWithCors({ message: 'Forbidden: platform admin required' }, { status: 403 }, origin);
    }

    const meta = new MetaCloudService();
    const result = await meta.getTemplates();
    return jsonWithCors(result, undefined, origin);
  } catch (error) {
    logger.error('[TEMPLATES] GET error:', error);
    return jsonWithCors({ message: 'Internal server error' }, { status: 500 }, origin);
  }
}

/**
 * POST /api/whatsapp/templates
 *
 * Platform admin only. Creates templates on the shared WABA.
 * Business owners use POST /api/whatsapp/templates/provision instead.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  try {
    // Platform admin required for all template creation via this route
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) {
      return jsonWithCors({ message: 'Forbidden: platform admin required' }, { status: 403 }, origin);
    }

    const body = await request.json();
    const { template } = body as { template: CreateTemplateInput };

    if (!template?.name || !template?.language || !template?.category || !template?.components?.length) {
      return jsonWithCors({ message: 'Missing required template fields: name, language, category, components' }, { status: 400 }, origin);
    }

    if (!/^[a-z][a-z0-9_]*$/.test(template.name) || template.name.length > 512) {
      return jsonWithCors({ message: 'Template name must be lowercase letters, numbers, and underscores only' }, { status: 400 }, origin);
    }

    const meta = new MetaCloudService();
    const result = await meta.createTemplate(template);
    return jsonWithCors(result, undefined, origin);
  } catch (error) {
    logger.error('[TEMPLATES] POST error:', error);
    return jsonWithCors({ message: 'Internal server error' }, { status: 500 }, origin);
  }
}

/**
 * DELETE /api/whatsapp/templates?name=xxx
 *
 * Platform admin only. Deletes templates from the shared WABA.
 */
export async function DELETE(request: NextRequest) {
  const origin = request.headers.get('origin');
  try {
    // Platform admin required for all template deletion via this route
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) {
      return jsonWithCors({ message: 'Forbidden: platform admin required' }, { status: 403 }, origin);
    }

    const { searchParams } = new URL(request.url);
    const name = searchParams.get('name');

    if (!name) {
      return jsonWithCors({ message: 'Template name is required' }, { status: 400 }, origin);
    }

    const meta = new MetaCloudService();
    const result = await meta.deleteTemplate(name);
    return jsonWithCors(result, undefined, origin);
  } catch (error) {
    logger.error('[TEMPLATES] DELETE error:', error);
    return jsonWithCors({ message: 'Internal server error' }, { status: 500 }, origin);
  }
}
