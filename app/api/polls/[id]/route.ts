import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: poll } = await supabase.from('polls').select('business_id').eq('id', id).single();
  if (!poll) return NextResponse.json({ error: 'Poll not found' }, { status: 404 });

  const { data: biz } = await supabase.from('businesses').select('id').eq('id', poll.business_id).eq('owner_id', user.id).single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  const body = await request.json();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status) updates.status = body.status;
  if (body.question) updates.question = body.question;
  if (body.options) updates.options = body.options;
  if (body.closes_at !== undefined) updates.closes_at = body.closes_at;

  const { data, error } = await supabase.from('polls').update(updates).eq('id', id).select().single();
  if (error) { logger.error('[POLLS] Update error:', error.message); return NextResponse.json({ error: 'Update failed' }, { status: 500 }); }
  return NextResponse.json({ poll: data });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: poll } = await supabase.from('polls').select('business_id').eq('id', id).single();
  if (!poll) return NextResponse.json({ error: 'Poll not found' }, { status: 404 });

  const { data: biz } = await supabase.from('businesses').select('id').eq('id', poll.business_id).eq('owner_id', user.id).single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  await supabase.from('polls').delete().eq('id', id);
  return NextResponse.json({ success: true });
}
