import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { parsePromoCsv, previewImport, executeImport } from '@/lib/promotions/import';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const service = createServiceClient();

  const contentType = request.headers.get('content-type') || '';

  let businessId: string | undefined;
  let campaignId: string | undefined;
  let csvText: string | undefined;
  let preview: boolean = false;
  let retryBatchId: string | undefined;

  if (contentType.includes('multipart/form-data')) {
    // --- FormData path: create wizard sends file + batch_id + campaign_id ---
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: 'Failed to parse form data' }, { status: 400 });
    }

    const file = formData.get('file') as File | null;
    const rawCampaignId = formData.get('campaign_id');
    campaignId = typeof rawCampaignId === 'string' ? rawCampaignId : undefined;
    const rawBatchId = formData.get('batch_id');
    retryBatchId = typeof rawBatchId === 'string' ? rawBatchId : undefined;

    if (!file) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }
    if (!campaignId) {
      return NextResponse.json({ error: 'campaign_id is required' }, { status: 400 });
    }

    try {
      csvText = await file.text();
    } catch {
      return NextResponse.json({ error: 'Failed to read uploaded file' }, { status: 400 });
    }

    // Infer businessId from campaign ownership (verified below after guard)
    // We look it up after auth so we can pass it to requireCapability.
    const { data: campaignRow, error: lookupError } = await service
      .from('promo_campaigns')
      .select('id, business_id, status')
      .eq('id', campaignId)
      .maybeSingle();

    if (lookupError || !campaignRow) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    }

    businessId = campaignRow.business_id;
  } else {
    // --- JSON path: detail page sends { businessId, campaignId, csvText, preview? } ---
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    businessId = body.businessId as string | undefined;
    campaignId = body.campaignId as string | undefined;
    csvText = body.csvText as string | undefined;
    preview = body.preview === true;
    retryBatchId = body.batchId as string | undefined;
  }

  if (!businessId) {
    return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
  }

  const guard = await requireCapability(supabase, service, {
    businessId,
    userId: user.id,
    capability: 'promo_verification',
    action: 'create_new',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  if (!campaignId || typeof campaignId !== 'string') {
    return NextResponse.json({ error: 'campaignId is required' }, { status: 400 });
  }
  if (!csvText || typeof csvText !== 'string' || !csvText.trim()) {
    return NextResponse.json({ error: 'csvText (or file) is required' }, { status: 400 });
  }

  // Verify campaign belongs to this business
  const { data: campaign, error: fetchError } = await service
    .from('promo_campaigns')
    .select('id, status, integrity_locked')
    .eq('id', campaignId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (fetchError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  // Only allow import in draft/scheduled — deny active/paused/ended/archived
  const importAllowedStatuses = ['draft', 'scheduled'];
  if (!importAllowedStatuses.includes(campaign.status)) {
    return NextResponse.json({
      error: `Cannot import codes for a campaign with status '${campaign.status}'. Import is only allowed for draft or scheduled campaigns.`,
    }, { status: 409 });
  }
  if (campaign.integrity_locked) {
    return NextResponse.json({
      error: 'Cannot import codes — campaign integrity is locked after first redemption.',
    }, { status: 409 });
  }

  // Parse CSV
  const rows = parsePromoCsv(csvText);
  if (rows.length === 0) {
    return NextResponse.json({ error: 'CSV contains no parseable rows' }, { status: 400 });
  }
  if (rows.length > 50_000) {
    return NextResponse.json({ error: 'V1 supports up to 50,000 codes per import. For larger campaigns, split into multiple imports.' }, { status: 400 });
  }

  // Build prize map (name -> id) for validation
  const { data: prizes } = await service
    .from('promo_prizes')
    .select('id, name')
    .eq('campaign_id', campaignId);

  const prizeMap = new Map<string, string>(
    (prizes || []).map((p: { id: string; name: string }) => [p.name, p.id]),
  );

  // Preview mode — validate without committing
  if (preview === true) {
    const previewResult = await previewImport(campaignId, businessId, rows, prizeMap);
    return NextResponse.json({ preview: previewResult });
  }

  // Pre-validate CSV before creating a batch — reject malformed/unknown-prize rows upfront.
  // This prevents creating orphan failed batches for CSVs that cannot complete cleanly.
  const preValidation = await previewImport(campaignId, businessId, rows, prizeMap);
  if (preValidation.malformedRows > 0) {
    return NextResponse.json({
      error: `CSV contains ${preValidation.malformedRows} invalid rows (malformed codes, unknown prizes, or invalid outcomes). Fix the CSV and retry.`,
      validation: preValidation,
    }, { status: 422 });
  }
  // Reject CSV with in-file duplicates before batch creation
  if (preValidation.duplicateRows > 0) {
    return NextResponse.json({
      error: `CSV contains ${preValidation.duplicateRows} duplicate code(s). Remove duplicates and retry.`,
      validation: preValidation,
    }, { status: 422 });
  }

  // Support same-batch retry for failed batches — authoritative batch contract
  let batchId: string;
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
    if (existingBatch.source !== 'imported') {
      return NextResponse.json({ error: `Cannot retry: batch source is '${existingBatch.source}', expected 'imported'` }, { status: 422 });
    }
    if (existingBatch.status !== 'failed') {
      return NextResponse.json({ error: `Cannot retry: batch status is '${existingBatch.status}', only failed batches can be retried` }, { status: 422 });
    }
    // Submitted CSV row count must match the authoritative batch requested_count
    if (rows.length !== existingBatch.requested_count) {
      return NextResponse.json({
        error: `Row count mismatch: batch requested_count is ${existingBatch.requested_count} but CSV has ${rows.length} rows. Submit the same CSV.`,
      }, { status: 422 });
    }

    const { data: resetResult, error: resetError } = await service.rpc('reset_promo_failed_batch', {
      p_batch_id: retryBatchId,
    });
    if (resetError || !resetResult?.success) {
      return NextResponse.json({ error: resetResult?.error || 'Failed to reset batch' }, { status: 422 });
    }
    batchId = retryBatchId;
  } else {
    // Atomic batch creation serialized on campaign row
    const { data: batchResult, error: batchError } = await service.rpc('create_promo_batch_atomic', {
      p_campaign_id: campaignId, p_source: 'imported', p_requested_count: rows.length,
    });
    if (batchError || !batchResult?.success) {
      logger.error('[PROMOTIONS] import batch create error:', batchError);
      return NextResponse.json({ error: batchResult?.error || 'Failed to create import batch' }, { status: 500 });
    }
    batchId = batchResult.batch_id;
  }

  const result = await executeImport(campaignId, businessId, batchId, rows, prizeMap);

  // Re-fetch authoritative final batch state
  const { data: finalBatch } = await service
    .from('promo_code_batches')
    .select('*')
    .eq('id', batchId)
    .single();

  // Return based on authoritative final batch status
  if (finalBatch?.status !== 'completed' || result.hasRpcFailures) {
    return NextResponse.json({
      error: 'Import failed — batch did not complete successfully',
      batchId,
      status: finalBatch?.status || 'failed',
      imported: result.imported,
      duplicates: result.duplicates,
      failed: result.failed,
      errors: result.errors.slice(0, 20),
      retryAvailable: true,
    }, { status: 500 });
  }

  return NextResponse.json({
    batchId,
    imported: result.imported,
    duplicates: result.duplicates,
    failed: result.failed,
    errors: result.errors.slice(0, 50),
    batch: finalBatch,
  }, { status: 201 });
}
