import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import type { PromoPrizeType } from '@/lib/promotions/types';
import { validatePrefix, validateGeneratedEntropy } from '@/lib/promotions/normalize';

interface PrizeInput {
  name: string;
  prize_type: PromoPrizeType;
  quantity: number;
  value?: number;
  currency?: string;
  fulfillment_instructions?: string | null;
  verification_mode?: string;
  sort_order?: number;
}

interface CodeConfig {
  source: 'generated' | 'imported';
  count?: number;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const service = createServiceClient();

  // The wizard nests everything under `campaign`
  const campaignInput = body.campaign as Record<string, unknown> | undefined;
  if (!campaignInput || typeof campaignInput !== 'object') {
    return NextResponse.json({ error: 'campaign object is required' }, { status: 400 });
  }

  const businessId = campaignInput.business_id as string | undefined;
  if (!businessId) {
    return NextResponse.json({ error: 'campaign.business_id is required' }, { status: 400 });
  }

  const guard = await requireCapability(supabase, service, {
    businessId,
    userId: user.id,
    capability: 'promo_verification',
    action: 'create_new',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  // Pull snake_case fields directly from campaign object
  const {
    name,
    description,
    start_at,
    end_at,
    timezone,
    keyword,
    code_entry_mode,
    accept_bare_codes,
    code_length,
    code_prefix,
    max_attempts_per_phone,
    rate_limit_window_minutes,
    rate_limit_max_attempts,
    eligibility_mode,
    eligibility_prompt,
    eligibility_min_age,
    max_wins_per_participant,
    winner_message,
    try_again_message,
    invalid_message,
    already_used_message,
    expired_message,
  } = campaignInput as {
    name?: string;
    description?: string;
    start_at?: string;
    end_at?: string;
    timezone?: string;
    keyword?: string;
    code_entry_mode?: string;
    accept_bare_codes?: boolean;
    code_length?: number;
    code_prefix?: string | null;
    max_attempts_per_phone?: number;
    rate_limit_window_minutes?: number;
    rate_limit_max_attempts?: number;
    max_wins_per_participant?: number | null;
    eligibility_mode?: string;
    eligibility_prompt?: string | null;
    eligibility_min_age?: number | null;
    winner_message?: string;
    try_again_message?: string;
    invalid_message?: string;
    already_used_message?: string;
    expired_message?: string;
  };

  // Validate required fields
  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'campaign.name is required' }, { status: 400 });
  }
  if (!winner_message || !try_again_message || !invalid_message || !already_used_message || !expired_message) {
    return NextResponse.json(
      {
        error:
          'All message fields (winner_message, try_again_message, invalid_message, already_used_message, expired_message) are required',
      },
      { status: 400 },
    );
  }

  const validEntryModes = ['keyword', 'bare_code', 'both'];
  if (code_entry_mode && !validEntryModes.includes(code_entry_mode)) {
    return NextResponse.json({ error: `code_entry_mode must be one of: ${validEntryModes.join(', ')}` }, { status: 400 });
  }

  // ── Routing consistency validation ──
  // Derive accept_bare_codes from code_entry_mode; reject contradictions
  const effectiveMode = code_entry_mode || 'both';
  const derivedBare = effectiveMode === 'bare_code' || effectiveMode === 'both';
  if (accept_bare_codes !== undefined && accept_bare_codes !== derivedBare) {
    return NextResponse.json({ error: 'routing_mode_conflict' }, { status: 400 });
  }
  // bare_code mode with non-empty keyword is contradictory
  if (effectiveMode === 'bare_code' && keyword?.trim()) {
    return NextResponse.json({ error: 'bare_code mode cannot have a keyword' }, { status: 400 });
  }
  // keyword/both mode requires keyword
  if ((effectiveMode === 'keyword' || effectiveMode === 'both') && !keyword?.trim()) {
    return NextResponse.json({ error: 'keyword is required for ' + effectiveMode + ' mode' }, { status: 400 });
  }

  const validEligibilityModes = ['none', 'age_confirmation', 'custom'];
  if (eligibility_mode && !validEligibilityModes.includes(eligibility_mode)) {
    return NextResponse.json(
      { error: `eligibility_mode must be one of: ${validEligibilityModes.join(', ')}` },
      { status: 400 },
    );
  }

  // Validate code_length: must produce at least MIN_GENERATED_BODY_LENGTH random characters
  const effectiveLength = typeof code_length === 'number' ? code_length : 12;
  if (effectiveLength < 10 || effectiveLength > 24 || !Number.isInteger(effectiveLength)) {
    return NextResponse.json({ error: 'code_length must be an integer between 10 and 24' }, { status: 400 });
  }

  // Validate code_prefix
  const normalizedPrefix = (code_prefix as string | undefined)?.trim().toUpperCase() || '';
  if (normalizedPrefix) {
    const prefixValidation = validatePrefix(normalizedPrefix, effectiveLength);
    if (!prefixValidation.valid) {
      return NextResponse.json({ error: prefixValidation.error }, { status: 400 });
    }
  }

  // Enforce minimum random body entropy for generated codes
  const entropyCheck = validateGeneratedEntropy(effectiveLength, normalizedPrefix || null);
  if (!entropyCheck.valid) {
    return NextResponse.json({ error: entropyCheck.error }, { status: 400 });
  }

  // Prizes come as a top-level array
  const prizesRaw = body.prizes;
  const prizeList: PrizeInput[] = Array.isArray(prizesRaw) ? (prizesRaw as PrizeInput[]) : [];
  const validPrizeTypes = ['cash', 'airtime', 'product', 'voucher', 'discount', 'custom'];
  for (let i = 0; i < prizeList.length; i++) {
    const p = prizeList[i];
    if (!p.name || typeof p.name !== 'string') {
      return NextResponse.json({ error: `prizes[${i}].name is required` }, { status: 400 });
    }
    if (!p.prize_type || !validPrizeTypes.includes(p.prize_type)) {
      return NextResponse.json(
        { error: `prizes[${i}].prize_type must be one of: ${validPrizeTypes.join(', ')}` },
        { status: 400 },
      );
    }
    if (typeof p.quantity !== 'number' || p.quantity < 1 || !Number.isInteger(p.quantity)) {
      return NextResponse.json({ error: `prizes[${i}].quantity must be a positive integer` }, { status: 400 });
    }
  }

  // code_config determines whether to create a batch record
  const codeConfig = body.code_config as CodeConfig | undefined;
  const validSources = ['generated', 'imported'];
  if (codeConfig && codeConfig.source && !validSources.includes(codeConfig.source)) {
    return NextResponse.json(
      { error: `code_config.source must be one of: ${validSources.join(', ')}` },
      { status: 400 },
    );
  }

  // Validate fraud-control numerics (server-authoritative)
  if (max_attempts_per_phone !== undefined) {
    const v = Number(max_attempts_per_phone);
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
      return NextResponse.json({ error: 'max_attempts_per_phone must be a positive integer' }, { status: 400 });
    }
  }
  if (rate_limit_window_minutes !== undefined) {
    const v = Number(rate_limit_window_minutes);
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
      return NextResponse.json({ error: 'rate_limit_window_minutes must be a positive integer' }, { status: 400 });
    }
  }
  if (rate_limit_max_attempts !== undefined) {
    const v = Number(rate_limit_max_attempts);
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
      return NextResponse.json({ error: 'rate_limit_max_attempts must be a positive integer' }, { status: 400 });
    }
  }
  if (eligibility_min_age !== undefined && eligibility_min_age !== null) {
    const v = Number(eligibility_min_age);
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
      return NextResponse.json({ error: 'eligibility_min_age must be a positive integer' }, { status: 400 });
    }
  }
  if (max_wins_per_participant !== undefined && max_wins_per_participant !== null) {
    const v = Number(max_wins_per_participant);
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
      return NextResponse.json({ error: 'max_wins_per_participant must be a positive integer or null (unlimited)' }, { status: 400 });
    }
  }

  // Validate prize verification_mode
  const validVerificationModes = ['standard', 'secure_pickup'];
  for (let i = 0; i < prizeList.length; i++) {
    const p = prizeList[i];
    if (p.verification_mode && !validVerificationModes.includes(p.verification_mode as string)) {
      return NextResponse.json({ error: `prizes[${i}].verification_mode must be one of: ${validVerificationModes.join(', ')}` }, { status: 400 });
    }
  }

  // Insert campaign
  const { data: campaign, error: campaignError } = await service
    .from('promo_campaigns')
    .insert({
      business_id: businessId,
      name: name.trim(),
      description: (description as string | undefined)?.trim() || null,
      status: 'draft',
      start_at: start_at || null,
      end_at: end_at || null,
      timezone: timezone || 'UTC',
      code_entry_mode: effectiveMode,
      keyword: keyword?.trim().toUpperCase() || null,
      accept_bare_codes: derivedBare,
      code_length: effectiveLength,
      code_prefix: normalizedPrefix || null,
      max_attempts_per_phone: max_attempts_per_phone ?? 3,
      rate_limit_window_minutes: rate_limit_window_minutes ?? 60,
      rate_limit_max_attempts: rate_limit_max_attempts ?? 5,
      eligibility_mode: eligibility_mode || 'none',
      eligibility_prompt: eligibility_prompt?.trim() || null,
      eligibility_min_age: eligibility_min_age || null,
      max_wins_per_participant: max_wins_per_participant ?? null,
      winner_message: winner_message.trim(),
      try_again_message: try_again_message.trim(),
      invalid_message: invalid_message.trim(),
      already_used_message: already_used_message.trim(),
      expired_message: expired_message.trim(),
      integrity_locked: false,
      created_by: user.id,
    })
    .select()
    .single();

  if (campaignError || !campaign) {
    logger.error('[PROMOTIONS] create campaign error:', campaignError);
    return NextResponse.json({ error: 'Failed to create campaign' }, { status: 500 });
  }

  // Insert prizes
  let insertedPrizes: unknown[] = [];
  if (prizeList.length > 0) {
    const { data: prizesData, error: prizesError } = await service
      .from('promo_prizes')
      .insert(
        prizeList.map((p, i) => ({
          campaign_id: campaign.id,
          name: p.name.trim(),
          prize_type: p.prize_type,
          quantity: p.quantity,
          allocated_count: 0,
          value: p.value ?? null,
          currency: p.currency?.toUpperCase() || null,
          fulfillment_instructions: p.fulfillment_instructions?.trim() || null,
          verification_mode: p.verification_mode || 'standard',
          sort_order: p.sort_order ?? i,
        })),
      )
      .select();

    if (prizesError) {
      logger.error('[PROMOTIONS] create prizes error:', prizesError);
      // Campaign was created; clean up before returning error
      await service.from('promo_campaigns').delete().eq('id', campaign.id);
      return NextResponse.json({ error: 'Failed to create prizes' }, { status: 500 });
    }

    insertedPrizes = prizesData || [];
  }

  // Do NOT pre-create a pending batch — generation route creates its own batch
  // when generation is actually started. Import route creates its own batch too.
  // This prevents orphan pending batches that block activation validation.

  return NextResponse.json(
    {
      id: campaign.id,
      campaign,
      prizes: insertedPrizes,
    },
    { status: 201 },
  );
}
