import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

type Params = { params: Promise<{ id: string }> };

// GET /api/surveys/[id] — get a single survey with response stats
export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: survey, error } = await supabase
    .from('surveys')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !survey) return NextResponse.json({ error: 'Survey not found' }, { status: 404 });

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', survey.business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  // Get response stats
  const [{ count: totalResponses }, { count: completedResponses }] = await Promise.all([
    supabase.from('survey_responses').select('id', { count: 'exact', head: true }).eq('survey_id', id),
    supabase.from('survey_responses').select('id', { count: 'exact', head: true }).eq('survey_id', id).eq('completed', true),
  ]);

  return NextResponse.json({
    survey,
    stats: {
      total_responses: totalResponses || 0,
      completed_responses: completedResponses || 0,
      completion_rate: totalResponses ? Math.round(((completedResponses || 0) / totalResponses) * 100) : 0,
    },
  });
}

// PATCH /api/surveys/[id] — update survey
export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { title, description, questions, status } = body as {
    title?: string;
    description?: string;
    questions?: Array<{ id: string; type: string; text: string; options?: string[]; required?: boolean }>;
    status?: 'draft' | 'active' | 'closed';
  };

  // Verify ownership
  const { data: existing } = await supabase.from('surveys').select('business_id').eq('id', id).single();
  if (!existing) return NextResponse.json({ error: 'Survey not found' }, { status: 404 });

  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', existing.business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (questions !== undefined) updates.questions = questions;
  if (status !== undefined) updates.status = status;

  const { data: survey, error } = await supabase
    .from('surveys')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    logger.error('[SURVEYS] Update error:', error.message);
    return NextResponse.json({ error: 'Failed to update survey' }, { status: 500 });
  }

  return NextResponse.json({ survey });
}

// DELETE /api/surveys/[id]
export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: existing } = await supabase.from('surveys').select('business_id').eq('id', id).single();
  if (!existing) return NextResponse.json({ error: 'Survey not found' }, { status: 404 });

  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', existing.business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  const { error } = await supabase.from('surveys').delete().eq('id', id);
  if (error) {
    logger.error('[SURVEYS] Delete error:', error.message);
    return NextResponse.json({ error: 'Failed to delete survey' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
