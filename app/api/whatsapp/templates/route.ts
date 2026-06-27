import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { MetaCloudService, type CreateTemplateInput } from '@/lib/channels/meta-cloud';
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

/** Wrap response with CORS headers */
function jsonWithCors(body: unknown, init?: { status?: number }, origin?: string | null) {
  return NextResponse.json(body, { ...init, headers: corsHeaders(origin) });
}

/**
 * GET /api/whatsapp/templates?business_id=xxx
 * List message templates for a business's WABA (or the shared WABA if no dedicated channel).
 * Admin callers can pass ?waba_id=xxx&access_token=xxx directly.
 */
export async function GET(request: NextRequest) {
  const origin = request.headers.get('origin');
  try {
    // Try cookie-based auth first, then Bearer token (admin panel is cross-origin)
    const supabase = await createClient();
    let { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.replace('Bearer ', '');
      if (token) {
        const service = createServiceClient();
        const { data } = await service.auth.getUser(token);
        user = data?.user || null;
      }
    }
    if (!user) {
      return jsonWithCors({ message: 'Unauthorized' }, { status: 401 }, origin);
    }

    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get('business_id');
    const directWabaId = searchParams.get('waba_id');
    const directToken = searchParams.get('access_token');

    let meta: MetaCloudService;

    if (directWabaId && directToken) {
      meta = new MetaCloudService({ accessToken: directToken, phoneNumberId: '', wabaId: directWabaId });
    } else if (businessId) {
      const service = createServiceClient();
      const { data: channel } = await service
        .from('whatsapp_channels')
        .select('waba_id, meta_access_token')
        .eq('business_id', businessId)
        .eq('provider', 'meta_cloud')
        .eq('is_active', true)
        .single();

      if (channel?.waba_id && channel?.meta_access_token) {
        meta = new MetaCloudService({ accessToken: channel.meta_access_token, phoneNumberId: '', wabaId: channel.waba_id });
      } else {
        meta = new MetaCloudService();
      }
    } else {
      meta = new MetaCloudService();
    }

    const result = await meta.getTemplates();
    return jsonWithCors(result, undefined, origin);
  } catch (error) {
    logger.error('[TEMPLATES] GET error:', error);
    return jsonWithCors({ message: 'Internal server error' }, { status: 500 }, origin);
  }
}

/**
 * POST /api/whatsapp/templates
 * Create a new message template on a WABA.
 * Body: { business_id?, waba_id?, access_token?, template: CreateTemplateInput }
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  try {
    const supabase = await createClient();
    let { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.replace('Bearer ', '');
      if (token) {
        const svc = createServiceClient();
        const { data } = await svc.auth.getUser(token);
        user = data?.user || null;
      }
    }
    if (!user) {
      return jsonWithCors({ message: 'Unauthorized' }, { status: 401 }, origin);
    }

    const body = await request.json();
    const { business_id, waba_id, access_token, template } = body as {
      business_id?: string;
      waba_id?: string;
      access_token?: string;
      template: CreateTemplateInput;
    };

    if (!template?.name || !template?.language || !template?.category || !template?.components?.length) {
      return jsonWithCors({ message: 'Missing required template fields: name, language, category, components' }, { status: 400 }, origin);
    }

    if (!/^[a-z][a-z0-9_]*$/.test(template.name) || template.name.length > 512) {
      return jsonWithCors({ message: 'Template name must be lowercase letters, numbers, and underscores only' }, { status: 400 }, origin);
    }

    let meta: MetaCloudService;

    if (waba_id && access_token) {
      meta = new MetaCloudService({ accessToken: access_token, phoneNumberId: '', wabaId: waba_id });
    } else if (business_id) {
      const service = createServiceClient();
      const { data: channel } = await service
        .from('whatsapp_channels')
        .select('waba_id, meta_access_token')
        .eq('business_id', business_id)
        .eq('provider', 'meta_cloud')
        .eq('is_active', true)
        .single();

      if (channel?.waba_id && channel?.meta_access_token) {
        meta = new MetaCloudService({ accessToken: channel.meta_access_token, phoneNumberId: '', wabaId: channel.waba_id });
      } else {
        meta = new MetaCloudService();
      }
    } else {
      meta = new MetaCloudService();
    }

    const result = await meta.createTemplate(template);
    return jsonWithCors(result, undefined, origin);
  } catch (error) {
    logger.error('[TEMPLATES] POST error:', error);
    return jsonWithCors({ message: 'Internal server error' }, { status: 500 }, origin);
  }
}

/**
 * DELETE /api/whatsapp/templates?name=xxx&business_id=xxx
 * Delete a message template by name.
 */
export async function DELETE(request: NextRequest) {
  const origin = request.headers.get('origin');
  try {
    const supabase = await createClient();
    let { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.replace('Bearer ', '');
      if (token) {
        const svc = createServiceClient();
        const { data } = await svc.auth.getUser(token);
        user = data?.user || null;
      }
    }
    if (!user) {
      return jsonWithCors({ message: 'Unauthorized' }, { status: 401 }, origin);
    }

    const { searchParams } = new URL(request.url);
    const name = searchParams.get('name');
    const businessId = searchParams.get('business_id');
    const directWabaId = searchParams.get('waba_id');
    const directToken = searchParams.get('access_token');

    if (!name) {
      return jsonWithCors({ message: 'Template name is required' }, { status: 400 }, origin);
    }

    let meta: MetaCloudService;

    if (directWabaId && directToken) {
      meta = new MetaCloudService({ accessToken: directToken, phoneNumberId: '', wabaId: directWabaId });
    } else if (businessId) {
      const service = createServiceClient();
      const { data: channel } = await service
        .from('whatsapp_channels')
        .select('waba_id, meta_access_token')
        .eq('business_id', businessId)
        .eq('provider', 'meta_cloud')
        .eq('is_active', true)
        .single();

      if (channel?.waba_id && channel?.meta_access_token) {
        meta = new MetaCloudService({ accessToken: channel.meta_access_token, phoneNumberId: '', wabaId: channel.waba_id });
      } else {
        meta = new MetaCloudService();
      }
    } else {
      meta = new MetaCloudService();
    }

    const result = await meta.deleteTemplate(name);
    return jsonWithCors(result, undefined, origin);
  } catch (error) {
    logger.error('[TEMPLATES] DELETE error:', error);
    return jsonWithCors({ message: 'Internal server error' }, { status: 500 }, origin);
  }
}
