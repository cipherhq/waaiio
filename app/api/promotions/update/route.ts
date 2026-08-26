import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import {
  isValidStatusTransition,
  type PromoCampaignStatus,
} from '@/lib/promotions/types';
import { validatePrefix, validateGeneratedEntropy } from '@/lib/promotions/normalize';

/**
 * Fields that cannot be changed once a campaign has redemptions (integrity-locked).
 * These affect the statistical fairness of the promotion.
 */
const INTEGRITY_LOCKED_FIELDS = [
  'codeEntryMode',
  'keyword',
  'acceptBareCodes',
  'codeFormat',
  'codeLength',
  'codePrefix',
  'maxAttemptsPerPhone',
  'rateLimitWindowMinutes',
  'rateLimitMaxAttempts',
  'eligibilityMode',
  'eligibilityMinAge',
  'maxWinsPerParticipant',
  'startAt',
  'endAt',
];

export async function PUT(request: NextRequest) {
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
  const businessId = body.businessId as string | undefined;

  if (!businessId) {
    return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
  }

  const guard = await requireCapability(supabase, service, {
    businessId,
    userId: user.id,
    capability: 'promo_verification',
    action: 'manage_existing',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  const { campaignId, status: newStatus } = body as {
    campaignId?: string;
    status?: string;
  };

  if (!campaignId || typeof campaignId !== 'string') {
    return NextResponse.json({ error: 'campaignId is required' }, { status: 400 });
  }

  // ── Keyword normalization ──
  if (body.keyword !== undefined) {
    body.keyword = body.keyword ? String(body.keyword).trim().toUpperCase() : null;
  }

  // ── Routing consistency validation ──
  const routingMode = body.codeEntryMode as string | undefined;
  const routingKeyword = body.keyword as string | null | undefined;
  const routingBare = body.acceptBareCodes as boolean | undefined;

  // If accept_bare_codes sent without code_entry_mode, reject (ambiguous)
  if (routingBare !== undefined && routingMode === undefined) {
    return NextResponse.json({ error: 'acceptBareCodes requires codeEntryMode to be specified' }, { status: 400 });
  }

  // If both code_entry_mode and accept_bare_codes provided, check consistency
  if (routingMode !== undefined && routingBare !== undefined) {
    const expectedBare = routingMode === 'bare_code' || routingMode === 'both';
    if (routingBare !== expectedBare) {
      return NextResponse.json({ error: 'routing_mode_conflict' }, { status: 400 });
    }
  }

  // bare_code mode with non-empty keyword is contradictory
  if (routingMode === 'bare_code' && routingKeyword) {
    return NextResponse.json({ error: 'bare_code mode cannot have a keyword' }, { status: 400 });
  }

  // Fetch existing campaign (verify it belongs to this business)
  const { data: campaign, error: fetchError } = await service
    .from('promo_campaigns')
    .select('*')
    .eq('id', campaignId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (fetchError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  // ── prizeUpdates: validate shape and reject mixed payloads early ──
  const rawPrizeUpdates = body.prizeUpdates;
  if (rawPrizeUpdates !== undefined) {
    // Must be an array
    if (!Array.isArray(rawPrizeUpdates)) {
      return NextResponse.json({ error: 'prizeUpdates must be an array' }, { status: 400 });
    }
    // Mixed payload check: prizeUpdates cannot be combined with ANY campaign mutation
    const campaignMutationFields = [
      'name', 'description', 'winnerMessage', 'tryAgainMessage', 'invalidMessage',
      'alreadyUsedMessage', 'expiredMessage', 'eligibilityPrompt', 'status',
      'startAt', 'endAt', 'timezone', 'codeEntryMode', 'keyword', 'acceptBareCodes',
      'codeFormat', 'codeLength', 'codePrefix', 'maxAttemptsPerPhone',
      'rateLimitWindowMinutes', 'rateLimitMaxAttempts', 'eligibilityMode',
      'eligibilityMinAge', 'maxWinsPerParticipant',
    ];
    const hasCampaignMutation = campaignMutationFields.some(f => f in body);
    if (hasCampaignMutation) {
      return NextResponse.json(
        { error: 'prizeUpdates cannot be combined with campaign mutations in one request' },
        { status: 400 },
      );
    }
    // Empty array: no-op, return current campaign
    if (rawPrizeUpdates.length === 0) {
      return NextResponse.json({ campaign });
    }
  }

  // If integrity_locked, reject changes to locked fields
  if (campaign.integrity_locked) {
    const lockedFieldsAttempted = INTEGRITY_LOCKED_FIELDS.filter((f) => f in body && body[f] !== undefined);
    if (lockedFieldsAttempted.length > 0) {
      return NextResponse.json(
        {
          error: `Cannot update integrity-locked fields after redemptions have occurred: ${lockedFieldsAttempted.join(', ')}`,
        },
        { status: 409 },
      );
    }
  }

  // Validate status transition
  if (newStatus !== undefined) {
    if (!isValidStatusTransition(campaign.status as PromoCampaignStatus, newStatus as PromoCampaignStatus)) {
      return NextResponse.json(
        {
          error: `Invalid status transition from '${campaign.status}' to '${newStatus}'`,
        },
        { status: 422 },
      );
    }
  }

  // Detect routing changes early — needed before activation check
  const isRoutingChange = !campaign.integrity_locked && ('codeEntryMode' in body || 'keyword' in body);

  // Fail-closed activation — use atomic RPC that validates + transitions
  const targetStatus = newStatus as PromoCampaignStatus | undefined;
  if (targetStatus === 'active') {
    // Reject activation combined with routing mutation — routing would be silently lost
    if (isRoutingChange) {
      return NextResponse.json(
        { error: 'Cannot combine status activation with routing changes in one request. Apply routing changes first, then activate.' },
        { status: 400 },
      );
    }
    const { data: activation, error: actError } = await service.rpc('activate_promo_campaign', {
      p_campaign_id: campaignId,
      p_actor_id: user.id,
      p_actor_role: 'business',
    });
    if (actError || !activation?.success) {
      // Check for conflict-specific errors from the RPC
      const rpcError = activation?.error;
      if (rpcError === 'keyword_conflict' || rpcError === 'bare_code_conflict') {
        return NextResponse.json({
          error: rpcError,
          conflicting_campaign: activation?.conflicting_campaign,
        }, { status: 409 });
      }
      return NextResponse.json({
        error: 'Campaign cannot be activated',
        validation_errors: activation?.validation_errors || [rpcError || actError?.message || 'Activation failed'],
      }, { status: 422 });
    }
    // Activation handled atomically — return early
    const { data: activated } = await service.from('promo_campaigns').select('*').eq('id', campaignId).single();
    return NextResponse.json({ campaign: activated });
  }

  // Validate code entropy when codeLength or codePrefix is being changed
  if (!campaign.integrity_locked && ('codeLength' in body || 'codePrefix' in body)) {
    const proposedLength = 'codeLength' in body && body.codeLength !== undefined
      ? Number(body.codeLength) : (campaign.code_length as number);
    const proposedPrefix = 'codePrefix' in body
      ? (body.codePrefix ? String(body.codePrefix).trim().toUpperCase() : '')
      : ((campaign.code_prefix as string) || '');

    if (!Number.isInteger(proposedLength) || proposedLength < 6 || proposedLength > 24) {
      return NextResponse.json({ error: 'code_length must be an integer between 6 and 24' }, { status: 400 });
    }
    if (proposedPrefix) {
      const prefixCheck = validatePrefix(proposedPrefix, proposedLength);
      if (!prefixCheck.valid) {
        return NextResponse.json({ error: prefixCheck.error }, { status: 400 });
      }
    }
    const entropyCheck = validateGeneratedEntropy(proposedLength, proposedPrefix || null);
    if (!entropyCheck.valid) {
      return NextResponse.json({ error: entropyCheck.error }, { status: 400 });
    }
  }

  // Build update payload — only include provided fields
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  // Always-updatable fields
  if ('name' in body && body.name !== undefined) updates.name = String(body.name).trim();
  if ('description' in body) updates.description = body.description ? String(body.description).trim() : null;
  if ('winnerMessage' in body && body.winnerMessage) updates.winner_message = String(body.winnerMessage).trim();
  if ('tryAgainMessage' in body && body.tryAgainMessage) updates.try_again_message = String(body.tryAgainMessage).trim();
  if ('invalidMessage' in body && body.invalidMessage) updates.invalid_message = String(body.invalidMessage).trim();
  if ('alreadyUsedMessage' in body && body.alreadyUsedMessage) updates.already_used_message = String(body.alreadyUsedMessage).trim();
  if ('expiredMessage' in body && body.expiredMessage) updates.expired_message = String(body.expiredMessage).trim();
  if ('eligibilityPrompt' in body) updates.eligibility_prompt = body.eligibilityPrompt ? String(body.eligibilityPrompt).trim() : null;
  if (newStatus !== undefined) updates.status = newStatus;

  // ── Routing fields: delegate to update_promo_campaign_routing RPC ──
  if (isRoutingChange) {
    const mode = (body.codeEntryMode as string) || (campaign.code_entry_mode as string);
    const kw = 'keyword' in body ? (body.keyword as string | null) : (campaign.keyword as string | null);

    const { data: routingResult, error: routingError } = await service.rpc('update_promo_campaign_routing', {
      p_campaign_id: campaignId,
      p_business_id: businessId,
      p_actor_id: user.id,
      p_code_entry_mode: mode,
      p_keyword: kw,
      p_reason: null,
    });

    if (routingError) {
      logger.error('[PROMOTIONS] routing RPC error:', routingError);
      return NextResponse.json({ error: 'Failed to update routing' }, { status: 500 });
    }

    if (routingResult && !routingResult.success) {
      const rpcError = routingResult.error as string;
      if (rpcError === 'keyword_conflict' || rpcError === 'bare_code_conflict') {
        return NextResponse.json({
          error: rpcError,
          conflicting_campaign: routingResult.conflicting_campaign,
        }, { status: 409 });
      }
      if (rpcError === 'integrity_locked') {
        return NextResponse.json({ error: rpcError }, { status: 409 });
      }
      if (rpcError === 'keyword_required' || rpcError === 'invalid_mode' || rpcError === 'routing_mode_conflict') {
        return NextResponse.json({ error: rpcError }, { status: 400 });
      }
      return NextResponse.json({ error: rpcError || 'Routing update failed' }, { status: 500 });
    }
  }

  // Non-integrity-locked updatable fields (only if not locked)
  // Note: routing fields (codeEntryMode, keyword, acceptBareCodes) handled above via RPC
  if (!campaign.integrity_locked) {
    if ('startAt' in body) updates.start_at = body.startAt || null;
    if ('endAt' in body) updates.end_at = body.endAt || null;
    if ('timezone' in body && body.timezone) updates.timezone = String(body.timezone);
    if ('codeFormat' in body && body.codeFormat) updates.code_format = String(body.codeFormat);
    if ('codeLength' in body && body.codeLength) updates.code_length = Number(body.codeLength);
    if ('codePrefix' in body) {
      const normalized = body.codePrefix ? String(body.codePrefix).trim().toUpperCase() : '';
      updates.code_prefix = normalized || null;
    }
    if ('maxAttemptsPerPhone' in body && body.maxAttemptsPerPhone !== undefined) {
      const v = Number(body.maxAttemptsPerPhone);
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
        return NextResponse.json({ error: 'max_attempts_per_phone must be a positive integer' }, { status: 400 });
      }
      updates.max_attempts_per_phone = v;
    }
    if ('rateLimitWindowMinutes' in body && body.rateLimitWindowMinutes !== undefined) {
      const v = Number(body.rateLimitWindowMinutes);
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
        return NextResponse.json({ error: 'rate_limit_window_minutes must be a positive integer' }, { status: 400 });
      }
      updates.rate_limit_window_minutes = v;
    }
    if ('rateLimitMaxAttempts' in body && body.rateLimitMaxAttempts !== undefined) {
      const v = Number(body.rateLimitMaxAttempts);
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
        return NextResponse.json({ error: 'rate_limit_max_attempts must be a positive integer' }, { status: 400 });
      }
      updates.rate_limit_max_attempts = v;
    }
    if ('eligibilityMode' in body && body.eligibilityMode) updates.eligibility_mode = String(body.eligibilityMode);
    if ('eligibilityMinAge' in body) {
      if (body.eligibilityMinAge !== null && body.eligibilityMinAge !== undefined) {
        const v = Number(body.eligibilityMinAge);
        if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
          return NextResponse.json({ error: 'eligibility_min_age must be a positive integer' }, { status: 400 });
        }
        updates.eligibility_min_age = v;
      } else {
        updates.eligibility_min_age = null;
      }
    }
    if ('maxWinsPerParticipant' in body) {
      if (body.maxWinsPerParticipant !== null && body.maxWinsPerParticipant !== undefined) {
        const v = Number(body.maxWinsPerParticipant);
        if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
          return NextResponse.json({ error: 'max_wins_per_participant must be a positive integer or null' }, { status: 400 });
        }
        updates.max_wins_per_participant = v;
      } else {
        updates.max_wins_per_participant = null;
      }
    }
  }

  // ── Prize updates (shape already validated above; rawPrizeUpdates is a non-empty array if we reach here) ──
  let updatedPrizes: unknown[] | undefined;

  if (Array.isArray(rawPrizeUpdates) && rawPrizeUpdates.length > 0) {
    const prizeUpdates = rawPrizeUpdates as Array<{ prizeId: string; prize_instructions?: string | null }>;

    // Validate types before calling RPC
    for (let i = 0; i < prizeUpdates.length; i++) {
      const pu = prizeUpdates[i];
      if (!pu.prizeId || typeof pu.prizeId !== 'string') {
        return NextResponse.json({ error: `prizeUpdates[${i}].prizeId is required` }, { status: 400 });
      }
      if (pu.prize_instructions !== undefined && pu.prize_instructions !== null) {
        if (typeof pu.prize_instructions !== 'string') {
          return NextResponse.json({ error: `prizeUpdates[${i}].prize_instructions must be a string` }, { status: 400 });
        }
        if (pu.prize_instructions.length > 500) {
          return NextResponse.json({ error: `prizeUpdates[${i}].prize_instructions must be at most 500 characters` }, { status: 400 });
        }
      }
    }

    // Build RPC payload and call atomic update_prize_instructions
    const rpcPayload = prizeUpdates.map(pu => ({
      prize_id: pu.prizeId,
      prize_instructions: pu.prize_instructions?.trim() ?? null,
    }));

    const { data: rpcResult, error: rpcError } = await service.rpc('update_prize_instructions', {
      p_campaign_id: campaignId,
      p_business_id: businessId,
      p_actor_id: user.id,
      p_updates: rpcPayload,
    });

    if (rpcError) {
      logger.error('[PROMOTIONS] prize update RPC error:', rpcError);
      return NextResponse.json({ error: rpcError.message }, { status: 500 });
    }
    if (!rpcResult?.success) {
      const err = (rpcResult as Record<string, unknown>)?.error as string | undefined;
      if (err === 'integrity_locked') {
        return NextResponse.json({ error: 'Cannot update prizes: campaign is integrity_locked' }, { status: 409 });
      }
      if (err === 'campaign_not_found') {
        return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
      }
      return NextResponse.json({ error: err || 'Prize update failed' }, { status: 400 });
    }

    // Reload canonical prize state
    const { data: reloadedPrizes } = await service
      .from('promo_prizes')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('sort_order');

    return NextResponse.json({ campaign, prizes: reloadedPrizes || [] });
  }

  if (Object.keys(updates).length === 1) {
    // Only updated_at — nothing else to update via direct UPDATE.
    // If routing changed via RPC, reload to return canonical post-RPC state.
    if (isRoutingChange) {
      const { data: reloaded } = await service
        .from('promo_campaigns')
        .select('*')
        .eq('id', campaignId)
        .single();
      return NextResponse.json({ campaign: reloaded || campaign });
    }
    if (!updatedPrizes) {
      // No routing, no prizes — nothing to do
    return NextResponse.json({ campaign }, { status: 200 });
  }

  let updatedCampaign = campaign;
  if (Object.keys(updates).length > 1) {
    const { data: updated, error: updateError } = await service
      .from('promo_campaigns')
      .update(updates)
      .eq('id', campaignId)
      .select()
      .single();

    if (updateError) {
      logger.error('[PROMOTIONS] update error:', updateError);
      return NextResponse.json({ error: 'Failed to update campaign' }, { status: 500 });
    }
    updatedCampaign = updated;
  }

  return NextResponse.json({
    campaign: updatedCampaign,
    ...(updatedPrizes ? { prizes: updatedPrizes } : {}),
  });
}
