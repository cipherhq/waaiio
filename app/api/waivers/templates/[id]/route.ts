import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { title, body: waiverBody, fields, is_active, require_before_booking, pdf_url } = body;

    // Build update object with only provided fields
    const updates: Record<string, unknown> = {};
    if (title !== undefined) updates.title = title;
    if (waiverBody !== undefined) updates.body = waiverBody;
    if (fields !== undefined) updates.fields = fields;
    if (is_active !== undefined) updates.is_active = is_active;
    if (require_before_booking !== undefined) updates.require_before_booking = require_before_booking;
    if (pdf_url !== undefined) updates.pdf_url = pdf_url;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    // RLS ensures only the owner can update
    const { data, error } = await supabase
      .from('waiver_templates')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      logger.error('Failed to update waiver template:', error);
      return NextResponse.json({ error: 'Template not found or update failed' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (err) {
    logger.error('Waiver template PATCH error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Soft delete — set is_active = false (RLS ensures ownership)
    const { data, error } = await supabase
      .from('waiver_templates')
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      logger.error('Failed to deactivate waiver template:', error);
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('Waiver template DELETE error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
