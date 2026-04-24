import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { MetaCloudService, type CreateTemplateInput } from '@/lib/channels/meta-cloud';

/**
 * GET /api/whatsapp/templates?business_id=xxx
 * List message templates for a business's WABA (or the shared WABA if no dedicated channel).
 * Admin callers can pass ?waba_id=xxx&access_token=xxx directly.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get('business_id');
    const directWabaId = searchParams.get('waba_id');
    const directToken = searchParams.get('access_token');

    let meta: MetaCloudService;

    if (directWabaId && directToken) {
      // Admin direct access to a specific WABA
      meta = new MetaCloudService({ accessToken: directToken, phoneNumberId: '', wabaId: directWabaId });
    } else if (businessId) {
      // Look up the business's dedicated channel
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
        // Fall back to shared WABA
        meta = new MetaCloudService();
      }
    } else {
      // Default: shared WABA
      meta = new MetaCloudService();
    }

    const result = await meta.getTemplates();
    return NextResponse.json(result);
  } catch (error) {
    console.error('[TEMPLATES] GET error:', error);
    return NextResponse.json(
      { message: error instanceof Error ? error.message : 'Failed to fetch templates' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/whatsapp/templates
 * Create a new message template on a WABA.
 * Body: { business_id?, waba_id?, access_token?, template: CreateTemplateInput }
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { business_id, waba_id, access_token, template } = body as {
      business_id?: string;
      waba_id?: string;
      access_token?: string;
      template: CreateTemplateInput;
    };

    if (!template?.name || !template?.language || !template?.category || !template?.components?.length) {
      return NextResponse.json(
        { message: 'Missing required template fields: name, language, category, components' },
        { status: 400 },
      );
    }

    // Validate template name: lowercase, underscores only, max 512 chars
    if (!/^[a-z][a-z0-9_]*$/.test(template.name) || template.name.length > 512) {
      return NextResponse.json(
        { message: 'Template name must be lowercase letters, numbers, and underscores only' },
        { status: 400 },
      );
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
    return NextResponse.json(result);
  } catch (error) {
    console.error('[TEMPLATES] POST error:', error);
    return NextResponse.json(
      { message: error instanceof Error ? error.message : 'Failed to create template' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/whatsapp/templates?name=xxx&business_id=xxx
 * Delete a message template by name.
 */
export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const name = searchParams.get('name');
    const businessId = searchParams.get('business_id');
    const directWabaId = searchParams.get('waba_id');
    const directToken = searchParams.get('access_token');

    if (!name) {
      return NextResponse.json({ message: 'Template name is required' }, { status: 400 });
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
    return NextResponse.json(result);
  } catch (error) {
    console.error('[TEMPLATES] DELETE error:', error);
    return NextResponse.json(
      { message: error instanceof Error ? error.message : 'Failed to delete template' },
      { status: 500 },
    );
  }
}
