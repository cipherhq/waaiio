/**
 * Promo code batch generation service.
 *
 * Handles chunked, resumable code generation for campaigns
 * with up to 50,000 codes per batch (V1 synchronous limit).
 *
 * Architecture:
 * - Generates codes in bounded chunks of CHUNK_SIZE
 * - Each chunk is committed atomically via commit_promo_code_chunk RPC
 * - The RPC locks the batch row (serializes concurrent workers)
 * - Prize inventory is checked + allocated inside the same transaction
 * - Progress cursor is advanced atomically with code insertion
 * - Interrupted batch resumes from the DB cursor (not memory)
 */
import { createServiceClient } from '@/lib/supabase/service';
import { normalizePromoCode, getDisplaySuffix, computeBodyLength, isRoutablePromoCode } from './normalize';
import { hashPromoCode, encryptPromoCode, generateCodeBatch } from './crypto';
import { randomInt } from 'crypto';
import type { PromoCodeOutcome } from './types';

const CHUNK_SIZE = 1000;

interface PrizeAllocation {
  prize_id: string;
  quantity: number;
}

interface GenerationConfig {
  campaignId: string;
  businessId: string;
  batchId: string;
  totalCount: number;
  codeLength: number;
  codePrefix?: string;
  prizes: PrizeAllocation[];
}

interface GenerationResult {
  generated: number;
  failed: number;
  completed: boolean;
}

/**
 * Decide outcomes for a chunk using cryptographically secure randomness.
 * Uses reservoir sampling — each code has P(winners_left / codes_left) chance.
 * Memory bounded to chunk size.
 */
function assignChunkOutcomes(
  chunkSize: number,
  remainingWinners: Array<{ prizeId: string; remaining: number }>,
  totalRemainingCodes: number,
): Array<{ outcome: PromoCodeOutcome; prizeId: string | null }> {
  const results: Array<{ outcome: PromoCodeOutcome; prizeId: string | null }> = [];
  const totalWinnersLeft = remainingWinners.reduce((s, w) => s + w.remaining, 0);

  // Build + shuffle prize slot list
  const prizeSlots: string[] = [];
  for (const w of remainingWinners) {
    for (let i = 0; i < w.remaining; i++) {
      prizeSlots.push(w.prizeId);
    }
  }
  for (let i = prizeSlots.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [prizeSlots[i], prizeSlots[j]] = [prizeSlots[j], prizeSlots[i]];
  }

  let winnersLeft = totalWinnersLeft;
  let codesLeft = totalRemainingCodes;
  let prizeIdx = 0;

  for (let i = 0; i < chunkSize; i++) {
    if (winnersLeft > 0 && codesLeft > 0) {
      // Cryptographically secure probability roll
      const roll = randomInt(0, codesLeft);
      if (roll < winnersLeft) {
        results.push({ outcome: 'winner', prizeId: prizeSlots[prizeIdx] || null });
        prizeIdx++;
        winnersLeft--;
      } else {
        results.push({ outcome: 'try_again', prizeId: null });
      }
    } else {
      results.push({ outcome: 'try_again', prizeId: null });
    }
    codesLeft--;
  }

  return results;
}

/**
 * Calculate remaining prize inventory from DB (concurrent-safe read).
 */
async function getRemainingPrizeInventory(
  supabase: ReturnType<typeof createServiceClient>,
  campaignId: string,
  prizes: PrizeAllocation[],
): Promise<Array<{ prizeId: string; remaining: number }>> {
  const result: Array<{ prizeId: string; remaining: number }> = [];
  for (const prize of prizes) {
    const { data: row } = await supabase
      .from('promo_prizes')
      .select('quantity, allocated_count')
      .eq('id', prize.prize_id)
      .single();
    const remaining = row ? Math.max(0, row.quantity - row.allocated_count) : 0;
    result.push({ prizeId: prize.prize_id, remaining });
  }
  return result;
}

/**
 * Generate codes for a campaign in bounded chunks.
 * Uses the atomic commit_promo_code_chunk RPC for each chunk.
 * Resumable: reads cursor from DB. Memory-bounded.
 */
export async function generatePromoCodes(config: GenerationConfig): Promise<GenerationResult> {
  const supabase = createServiceClient();

  // Read current batch state for resume
  const { data: batch } = await supabase
    .from('promo_code_batches')
    .select('progress_cursor, status, generated_count, requested_count')
    .eq('id', config.batchId)
    .single();

  if (!batch) throw new Error('Batch not found');
  if (batch.status === 'completed') {
    return { generated: batch.generated_count, failed: 0, completed: true };
  }

  let cursor = batch.progress_cursor || 0;
  let failed = 0;

  // Mark as processing
  await supabase.from('promo_code_batches').update({ status: 'processing' }).eq('id', config.batchId);

  const bodyLength = computeBodyLength(config.codeLength, config.codePrefix);

  try {
    while (cursor < config.totalCount) {
      const chunkSize = Math.min(CHUNK_SIZE, config.totalCount - cursor);
      const totalRemaining = config.totalCount - cursor;

      // Get remaining prize inventory from DB
      const remainingPrizes = await getRemainingPrizeInventory(supabase, config.campaignId, config.prizes);

      // Assign outcomes for this chunk (bounded memory)
      const outcomes = assignChunkOutcomes(chunkSize, remainingPrizes, totalRemaining);

      // Generate unique codes
      const rawCodes = generateCodeBatch(chunkSize, bodyLength, config.codePrefix);

      // Build JSONB array for the RPC
      const codeRows = rawCodes.map((rawCode, i) => {
        const normalized = normalizePromoCode(rawCode);
        return {
          hash: hashPromoCode(normalized),
          encrypted: encryptPromoCode(normalized),
          suffix: getDisplaySuffix(normalized),
          outcome: outcomes[i].outcome,
          prize_id: outcomes[i].prizeId || '',
        };
      });

      // Atomic commit via RPC — serializes cursor + prize allocation
      const { data: result, error } = await supabase.rpc('commit_promo_code_chunk', {
        p_batch_id: config.batchId,
        p_expected_cursor: cursor,
        p_codes: codeRows,
        p_chunk_size: chunkSize,
      });

      if (error) throw error;
      if (!result?.success) {
        if (result?.error === 'Cursor mismatch') {
          // Another worker advanced — re-read cursor and retry
          const { data: fresh } = await supabase
            .from('promo_code_batches')
            .select('progress_cursor, status')
            .eq('id', config.batchId)
            .single();
          if (fresh?.status === 'completed') {
            return { generated: config.totalCount, failed: 0, completed: true };
          }
          cursor = fresh?.progress_cursor ?? cursor;
          continue;
        }
        throw new Error(result?.error || 'Chunk commit failed');
      }

      cursor = result.new_cursor;
    }

    return { generated: cursor, failed, completed: true };
  } catch (err) {
    await supabase.from('promo_code_batches').update({
      status: 'failed',
      error_details: { error: String(err), cursor },
    }).eq('id', config.batchId);

    return { generated: cursor, failed, completed: false };
  }
}

/**
 * Validate prize allocation using the authoritative DB function.
 */
export async function validatePrizeAllocation(campaignId: string): Promise<{
  valid: boolean;
  errors: string[];
}> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc('validate_promo_campaign_activation', {
    p_campaign_id: campaignId,
  });

  if (error) {
    return { valid: false, errors: ['Validation query failed: ' + error.message] };
  }

  return {
    valid: data?.valid ?? false,
    errors: data?.errors ?? [],
  };
}
