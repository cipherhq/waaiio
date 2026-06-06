import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const businessId = request.nextUrl.searchParams.get('business_id');
    if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 });

    // Verify ownership via RLS — only owner's templates will be returned
    const { data, error } = await supabase
      .from('waiver_templates')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Failed to fetch waiver templates:', error);
      return NextResponse.json({ error: 'Failed to fetch templates' }, { status: 500 });
    }

    return NextResponse.json(data || []);
  } catch (err) {
    logger.error('Waiver templates GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { business_id, title, body: waiverBody, fields, require_before_booking } = body;

    if (!business_id || !title || !waiverBody) {
      return NextResponse.json({ error: 'business_id, title, and body are required' }, { status: 400 });
    }

    if (title.length > 300) {
      return NextResponse.json({ error: 'Title must be 300 characters or less' }, { status: 400 });
    }

    // Verify business ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .single();

    if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

    const { data, error } = await supabase
      .from('waiver_templates')
      .insert({
        business_id,
        title,
        body: waiverBody,
        fields: fields || ['name', 'signature', 'date'],
        require_before_booking: require_before_booking || false,
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to create waiver template:', error);
      return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    logger.error('Waiver templates POST error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
