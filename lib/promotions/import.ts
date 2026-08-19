/**
 * Promo code CSV import service.
 *
 * Uses commit_promo_import_chunk RPC for atomic code insertion + prize allocation.
 * Batch progress is DB-authoritative — app does NOT overwrite RPC-managed state.
 */
import { createServiceClient } from '@/lib/supabase/service';
import { normalizePromoCode, getDisplaySuffix, isImportablePromoCode } from './normalize';
import { hashPromoCode, encryptPromoCode } from './crypto';

const IMPORT_CHUNK_SIZE = 500;

interface ImportRow { code: string; outcome?: string; prize?: string; }
interface ImportError { row: number; code: string; error: string; }
interface ImportPreview {
  totalRows: number; validRows: number; duplicateRows: number;
  malformedRows: number; errors: ImportError[]; sampleCodes: string[];
}
interface ImportResult {
  imported: number; duplicates: number; failed: number;
  errors: ImportError[]; hasRpcFailures: boolean;
}

export function parsePromoCsv(csvText: string): ImportRow[] {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return [];
  const firstLine = lines[0].toLowerCase().trim();
  const hasHeader = firstLine.includes('code') || firstLine.includes('outcome') || firstLine.includes('prize');
  const startIdx = hasHeader ? 1 : 0;
  const rows: ImportRow[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split(',').map(p => p.trim().replace(/^"|"$/g, ''));
    if (parts.length === 0 || !parts[0]) continue;
    rows.push({ code: parts[0], outcome: parts[1] || undefined, prize: parts[2] || undefined });
  }
  return rows;
}

export async function previewImport(
  _campaignId: string, _businessId: string, rows: ImportRow[],
  prizeMap?: Map<string, string>,
): Promise<ImportPreview> {
  const errors: ImportError[] = [];
  const normalizedSet = new Set<string>();
  let duplicateRows = 0;
  let malformedRows = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const normalized = normalizePromoCode(row.code);
    if (!isImportablePromoCode(normalized)) { malformedRows++; errors.push({ row: i + 1, code: row.code, error: 'Invalid code format' }); continue; }
    if (normalizedSet.has(normalized)) { duplicateRows++; errors.push({ row: i + 1, code: row.code, error: 'Duplicate code in import file' }); continue; }
    normalizedSet.add(normalized);
    if (row.outcome && !['winner', 'try_again'].includes(row.outcome.toLowerCase())) { errors.push({ row: i + 1, code: row.code, error: `Invalid outcome: ${row.outcome}` }); malformedRows++; continue; }
    if (row.prize && prizeMap && !prizeMap.has(row.prize)) { errors.push({ row: i + 1, code: row.code, error: `Unknown prize: ${row.prize}` }); malformedRows++; }
  }
  return { totalRows: rows.length, validRows: rows.length - duplicateRows - malformedRows, duplicateRows, malformedRows, errors: errors.slice(0, 100), sampleCodes: rows.slice(0, 5).map(r => r.code) };
}

/**
 * Execute import using atomic commit_promo_import_chunk RPC.
 * Batch progress is DB-authoritative — app does NOT overwrite RPC state.
 * On chunk RPC failure: batch stays in processing state with accurate cursor.
 * Completion only if ALL chunks committed successfully with zero RPC failures.
 */
export async function executeImport(
  campaignId: string, businessId: string, batchId: string,
  rows: ImportRow[], prizeMap?: Map<string, string>,
): Promise<ImportResult> {
  const supabase = createServiceClient();
  let imported = 0;
  let duplicates = 0;
  let failed = 0;
  const errors: ImportError[] = [];
  const seenNormalized = new Set<string>();
  let hasRpcFailures = false;

  await supabase.from('promo_code_batches').update({ status: 'processing' }).eq('id', batchId);

  try {
    for (let chunkStart = 0; chunkStart < rows.length; chunkStart += IMPORT_CHUNK_SIZE) {
      const chunk = rows.slice(chunkStart, chunkStart + IMPORT_CHUNK_SIZE);
      const codeRows: Array<{ hash: string; encrypted: string; suffix: string; outcome: string; prize_id: string }> = [];

      for (const row of chunk) {
        const normalized = normalizePromoCode(row.code);
        if (!isImportablePromoCode(normalized)) { failed++; continue; }
        if (seenNormalized.has(normalized)) { duplicates++; continue; }
        seenNormalized.add(normalized);

        let outcome = 'try_again';
        if (row.outcome) {
          const lower = row.outcome.toLowerCase();
          if (lower === 'winner') outcome = 'winner';
          else if (lower === 'try_again') outcome = 'try_again';
          else { failed++; errors.push({ row: chunkStart + chunk.indexOf(row) + 1, code: row.code, error: `Invalid outcome: ${row.outcome}` }); continue; }
        }
        const prizeId = row.prize && prizeMap ? prizeMap.get(row.prize) || null : null;
        if (outcome === 'winner' && !prizeId) { failed++; errors.push({ row: chunkStart + chunk.indexOf(row) + 1, code: row.code, error: 'Winner requires valid prize' }); continue; }

        codeRows.push({ hash: hashPromoCode(normalized), encrypted: encryptPromoCode(normalized), suffix: getDisplaySuffix(normalized), outcome, prize_id: prizeId || '' });
      }

      if (codeRows.length > 0) {
        const { data: result, error: rpcError } = await supabase.rpc('commit_promo_import_chunk', {
          p_batch_id: batchId, p_codes: codeRows,
        });
        if (rpcError || !result?.success) {
          // RPC failure or DB duplicate collision — STOP processing further chunks
          hasRpcFailures = true;
          const rpcDuplicates = result?.duplicates || 0;
          duplicates += rpcDuplicates;
          imported += result?.imported || 0;
          failed += codeRows.length - (result?.imported || 0) - rpcDuplicates;
          errors.push({ row: chunkStart, code: '', error: rpcError?.message || result?.error || 'Chunk commit failed' });
          break; // Do NOT continue to later chunks after failure
        } else {
          imported += result.imported || 0;
          duplicates += result.duplicates || 0;
          // Batch cursor was advanced atomically by the RPC — do not overwrite
        }
      }
    }

    // Read authoritative batch state from DB (set by RPC commits)
    const { data: finalBatch } = await supabase
      .from('promo_code_batches')
      .select('generated_count, progress_cursor')
      .eq('id', batchId).single();

    // Only mark completed if zero RPC failures and all valid rows committed
    if (!hasRpcFailures && failed === 0) {
      await supabase.from('promo_code_batches').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      }).eq('id', batchId);
    } else if (hasRpcFailures) {
      // Leave as 'processing' with error details — retryable
      await supabase.from('promo_code_batches').update({
        status: 'failed',
        failed_count: failed,
        error_details: { errors: errors.slice(0, 10), has_rpc_failures: true },
      }).eq('id', batchId);
    } else {
      // Some format/validation failures but no RPC failures — completed with report
      await supabase.from('promo_code_batches').update({
        status: 'completed',
        failed_count: failed,
        completed_at: new Date().toISOString(),
      }).eq('id', batchId);
    }

    return { imported, duplicates, failed, errors, hasRpcFailures };
  } catch (err) {
    await supabase.from('promo_code_batches').update({
      status: 'failed', error_details: { error: String(err) },
    }).eq('id', batchId);
    return { imported, duplicates, failed: failed + (rows.length - imported), errors, hasRpcFailures: true };
  }
}

export function generateCsvTemplate(): string {
  return 'code,outcome,prize\nK7PM-4XQ9-N2WF,winner,Grand Prize\nABCD-EFGH-IJKL,try_again,\nMNOP-QRST-UVWX,,\n';
}
