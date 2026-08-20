import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { generatePromoCodes } from '@/lib/promotions/generate';
import { computeBodyLength, computeUsableCodeSpace, validateGeneratedEntropy } from '@/lib/promotions/normalize';

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const service = createServiceClient();
  const businessId = body.businessId as string | undefined;
  if (!businessId) return NextResponse.json({ error: 'businessId is required' }, { status: 400 });

  const guard = await requireCapability(supabase, service, {
    businessId, userId: user.id, capability: 'promo_verification', action: 'create_new',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  const { campaignId, count, batchId: retryBatchId } = body as { campaignId?: string; count?: number; batchId?: string };
  if (!campaignId) return NextResponse.json({ error: 'campaignId is required' }, { status: 400 });

  // count is optional on retry (stored requested_count is authoritative)
  if (!retryBatchId) {
    if (!count || typeof count !== 'number' || count < 1 || !Number.isInteger(count)) {
      return NextResponse.json({ error: 'count must be a positive integer' }, { status: 400 });
    }
    if (count > 50_000) {
      return NextResponse.json({ error: 'V1 supports up to 50,000 codes per batch. For larger campaigns, generate multiple batches.' }, { status: 400 });
    }
  }

  // Fetch campaign — use its canonical format, do NOT trust caller overrides
  const { data: campaign, error: fetchError } = await service
    .from('promo_campaigns')
    .select('id, status, integrity_locked, code_length, code_prefix')
    .eq('id', campaignId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (fetchError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  // Blocker 2: Only allow generation in draft/scheduled
  const allowedStatuses = ['draft', 'scheduled'];
  if (!allowedStatuses.includes(campaign.status)) {
    return NextResponse.json({
      error: `Cannot generate codes for a campaign with status '${campaign.status}'. Code generation is only allowed for draft or scheduled campaigns.`,
    }, { status: 409 });
  }
  if (campaign.integrity_locked) {
    return NextResponse.json({
      error: 'Cannot generate codes — campaign integrity is locked after first redemption.',
    }, { status: 409 });
  }

  // Use campaign's canonical format — no caller overrides
  const codeLength = campaign.code_length || 12;
  const codePrefix = campaign.code_prefix || undefined;
  const bodyLen = computeBodyLength(codeLength, codePrefix);

  // Server-side entropy enforcement — even if campaign was created before this rule
  const entropyCheck = validateGeneratedEntropy(codeLength, codePrefix);
  if (!entropyCheck.valid) {
    return NextResponse.json({ error: entropyCheck.error }, { status: 422 });
  }

  // Fetch prizes (needed for both new and retry)
  const { data: prizes } = await service
    .from('promo_prizes')
    .select('id, quantity')
    .eq('campaign_id', campaignId);

  const prizeAllocations = (prizes || []).map((p: { id: string; quantity: number }) => ({
    prize_id: p.id, quantity: p.quantity,
  }));

  // Code-space and prize validations use the effective count
  // (caller count for new batches, stored requested_count for retry — resolved below)
  const preValidateCount = count; // May be undefined on retry — validated after batch resolution
  if (preValidateCount) {
    const usableSpace = computeUsableCodeSpace(bodyLen, codePrefix);
    if (preValidateCount > usableSpace * 0.8) {
      return NextResponse.json({
        error: `Code space too small: usable unique codes ~${usableSpace} but ${preValidateCount} requested. Increase code length or reduce count.`,
      }, { status: 422 });
    }
    const totalWinners = prizeAllocations.reduce((sum, p) => sum + p.quantity, 0);
    if (totalWinners > preValidateCount) {
      return NextResponse.json({
        error: `Prize allocation (${totalWinners}) exceeds codes (${preValidateCount}).`,
      }, { status: 422 });
    }
  }

  // Support same-batch retry for failed batches — authoritative batch contract
  let resolvedBatchId: string | undefined;
  let resolvedCount: number;

  if (retryBatchId) {
    const { data: existingBatch } = await service
      .from('promo_code_batches')
      .select('id, status, campaign_id, source, requested_count')
      .eq('id', retryBatchId)
      .eq('campaign_id', campaignId)
      .maybeSingle();

    if (!existingBatch) {
      return NextResponse.json({ error: 'Batch not found for this campaign' }, { status: 404 });
    }
    if (existingBatch.source !== 'generated') {
      return NextResponse.json({ error: `Cannot retry: batch source is '${existingBatch.source}', expected 'generated'` }, { status: 422 });
    }
    if (existingBatch.status !== 'failed') {
      return NextResponse.json({ error: `Cannot retry: batch status is '${existingBatch.status}', only failed batches can be retried` }, { status: 422 });
    }
    // Use stored requested_count as authoritative — reject mismatched caller count
    if (count !== undefined && count !== existingBatch.requested_count) {
      return NextResponse.json({
        error: `Count mismatch: batch requested_count is ${existingBatch.requested_count} but caller sent ${count}. Omit count or match the stored value.`,
      }, { status: 422 });
    }

    const { data: resetResult, error: resetError } = await service.rpc('reset_promo_failed_batch', {
      p_batch_id: retryBatchId,
    });
    if (resetError || !resetResult?.success) {
      return NextResponse.json({ error: resetResult?.error || 'Failed to reset batch' }, { status: 422 });
    }

    resolvedBatchId = retryBatchId;
    resolvedCount = existingBatch.requested_count;
  } else {
    if (!count) {
      return NextResponse.json({ error: 'count must be a positive integer' }, { status: 400 });
    }
    resolvedCount = count;

    // Atomic batch creation serialized on campaign row
    const { data: batchResult, error: batchError } = await service.rpc('create_promo_batch_atomic', {
      p_campaign_id: campaignId, p_source: 'generated', p_requested_count: count,
    });
    if (batchError || !batchResult?.success) {
      logger.error('[PROMOTIONS] create batch error:', batchError);
      return NextResponse.json({ error: batchResult?.error || 'Failed to create batch record' }, { status: 500 });
    }
    resolvedBatchId = batchResult.batch_id;
  }

  const batchId = resolvedBatchId!;

  const result = await generatePromoCodes({
    campaignId, businessId, batchId,
    totalCount: resolvedCount, codeLength, codePrefix, prizes: prizeAllocations,
  });

  const { data: finalBatch } = await service
    .from('promo_code_batches').select('*').eq('id', batchId).single();

  // Return based on authoritative final batch status
  if (finalBatch?.status !== 'completed' || !result.completed) {
    return NextResponse.json({
      batchId, generated: result.generated,
      failed: result.failed, completed: false, batch: finalBatch,
      status: finalBatch?.status || 'failed',
      retryAvailable: true,
    }, { status: 500 });
  }

  return NextResponse.json({
    batchId, generated: result.generated,
    failed: result.failed, completed: true, batch: finalBatch,
  }, { status: 201 });
}
