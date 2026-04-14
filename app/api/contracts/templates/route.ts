import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /api/contracts/templates
 * List custom templates for the current user's business.
 * Query param: ?business_id=xxx
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const businessId = request.nextUrl.searchParams.get('business_id');
    if (!businessId) {
      return NextResponse.json({ error: 'business_id is required' }, { status: 400 });
    }

    // RLS ensures only business owners can see their templates
    const { data, error } = await supabase
      .from('contract_templates')
      .select('id, title, content, template_url, category, created_at, updated_at')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch templates:', error);
      return NextResponse.json({ error: 'Failed to fetch templates' }, { status: 500 });
    }

    return NextResponse.json({ templates: data || [] });
  } catch (err) {
    console.error('templates GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/contracts/templates
 * Save a new custom template.
 * Body: { business_id, title, content?, template_url? }
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { business_id, title, content, template_url } = body;

    if (!business_id || !title) {
      return NextResponse.json({ error: 'business_id and title are required' }, { status: 400 });
    }

    // RLS will enforce ownership
    const { data, error } = await supabase
      .from('contract_templates')
      .insert({
        business_id,
        title,
        content: content || null,
        template_url: template_url || null,
        category: 'custom',
      })
      .select('id, title, content, template_url, category, created_at')
      .single();

    if (error) {
      console.error('Failed to save template:', error);
      return NextResponse.json({ error: 'Failed to save template' }, { status: 500 });
    }

    return NextResponse.json({ template: data });
  } catch (err) {
    console.error('templates POST error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/contracts/templates?id=xxx
 * Delete a custom template.
 */
export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const templateId = request.nextUrl.searchParams.get('id');
    if (!templateId) {
      return NextResponse.json({ error: 'id query param is required' }, { status: 400 });
    }

    // RLS will enforce ownership
    const { error } = await supabase
      .from('contract_templates')
      .delete()
      .eq('id', templateId);

    if (error) {
      console.error('Failed to delete template:', error);
      return NextResponse.json({ error: 'Failed to delete template' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('templates DELETE error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
