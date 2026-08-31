import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { logger } from '@/lib/logger';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: poll } = await supabase.from('polls').select('*').eq('id', id).single();
  if (!poll) return NextResponse.json({ error: 'Poll not found' }, { status: 404 });

  const { data: biz } = await supabase.from('businesses').select('id').eq('id', poll.business_id).eq('owner_id', user.id).single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  // ── Capability enforcement: poll/manage_existing ──
  const service = createServiceClient();
  const guard = await requireCapability(supabase, service, {
    businessId: poll.business_id, userId: user.id, capability: 'poll', action: 'manage_existing',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  const body = await request.json();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  // ── Validate question if provided ──
  if (body.question !== undefined) {
    if (typeof body.question !== 'string' || !body.question.trim()) {
      return NextResponse.json({ error: 'Question must be a non-empty string' }, { status: 400 });
    }
    updates.question = body.question.trim();
  }

  // ── Validate options if provided ──
  if (body.options !== undefined) {
    if (!Array.isArray(body.options)) {
      return NextResponse.json({ error: 'Options must be an array' }, { status: 400 });
    }
    // Reject empty strings
    const cleaned = body.options.map((o: unknown) => typeof o === 'string' ? o.trim() : '');
    const hasEmpty = cleaned.some((o: string) => !o);
    if (hasEmpty) {
      return NextResponse.json({ error: 'Options must not contain empty strings' }, { status: 400 });
    }
    // Reject duplicates (case-insensitive)
    const lower = cleaned.map((o: string) => o.toLowerCase());
    const unique = new Set(lower);
    if (unique.size !== lower.length) {
      return NextResponse.json({ error: 'Options must not contain duplicates' }, { status: 400 });
    }
    if (cleaned.length < 2) {
      return NextResponse.json({ error: 'Poll must have at least 2 options' }, { status: 400 });
    }
    if (cleaned.length > 10) {
      return NextResponse.json({ error: 'Poll must have at most 10 options' }, { status: 400 });
    }
    updates.options = cleaned;
  }

  // ── Status validation ──
  const VALID_STATUSES = ['draft', 'active', 'closed'] as const;
  const VALID_TRANSITIONS: Record<string, string[]> = {
    draft: ['active'],
    active: ['closed'],
    closed: [],
  };

  if (body.status) {
    if (!VALID_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: `Invalid status: ${body.status}. Must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 });
    }
    const currentStatus = poll.status as string;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(body.status)) {
      return NextResponse.json({ error: `Invalid transition: ${currentStatus} -> ${body.status}` }, { status: 400 });
    }
    // Before activation: poll must have a question and 2-10 options
    if (body.status === 'active') {
      const effectiveQuestion = (updates.question as string) || poll.question;
      const effectiveOptions = (updates.options as string[]) || (poll.options as string[] | null);
      if (!effectiveQuestion || !effectiveQuestion.trim()) {
        return NextResponse.json({ error: 'Poll must have a question before activation' }, { status: 400 });
      }
      if (!effectiveOptions || effectiveOptions.length < 2) {
        return NextResponse.json({ error: 'Poll must have at least 2 options before activation' }, { status: 400 });
      }
      if (effectiveOptions.length > 10) {
        return NextResponse.json({ error: 'Poll must have at most 10 options' }, { status: 400 });
      }
    }
    updates.status = body.status;
  }

  // ── Guard active polls: don't allow saving invalid question/options ──
  if (poll.status === 'active' && !body.status) {
    const effectiveQuestion = (updates.question as string) || poll.question;
    const effectiveOptions = (updates.options as string[]) || (poll.options as string[] | null);
    if (!effectiveQuestion || !effectiveQuestion.trim()) {
      return NextResponse.json({ error: 'Cannot remove question from an active poll' }, { status: 400 });
    }
    if (!effectiveOptions || effectiveOptions.length < 2) {
      return NextResponse.json({ error: 'Active poll must maintain at least 2 options' }, { status: 400 });
    }
  }

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

  const { data: pollDel } = await supabase.from('polls').select('business_id').eq('id', id).single();
  if (!pollDel) return NextResponse.json({ error: 'Poll not found' }, { status: 404 });

  const { data: biz } = await supabase.from('businesses').select('id').eq('id', pollDel.business_id).eq('owner_id', user.id).single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  // ── Capability enforcement: poll/manage_existing ──
  const serviceDel = createServiceClient();
  const guardDel = await requireCapability(supabase, serviceDel, {
    businessId: pollDel.business_id, userId: user.id, capability: 'poll', action: 'manage_existing',
  });
  if (!guardDel.allowed) return NextResponse.json(guardDel.denial, { status: guardDel.status });

  await supabase.from('polls').delete().eq('id', id);
  return NextResponse.json({ success: true });
}
