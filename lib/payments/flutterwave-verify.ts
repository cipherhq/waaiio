/**
 * Flutterwave transaction verification helpers (M378).
 *
 * Implements the accepted provider verification contract:
 * 1. Discover candidate transaction(s) by durable tx_ref using GET /v3/transactions
 *    with bounded from/to dates
 * 2. Require unambiguous correlation (exactly one match with correct tx_ref)
 * 3. Verify discovered transaction with GET /v3/transactions/{id}/verify
 * 4. Return verified evidence or structured failure
 */

import { logger } from '@/lib/logger';

const FLW_BASE = 'https://api.flutterwave.com';

export interface FlutterwaveVerifiedTx {
  id: number;
  tx_ref: string;
  status: string;        // 'successful' | 'failed' | 'pending' | etc.
  amount: number;        // major units
  currency: string;
  created_at: string;    // ISO timestamp
  customer_email?: string;
  app_fee?: number;
}

export type VerifyResult =
  | { ok: true; tx: FlutterwaveVerifiedTx }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable' | 'verification_failed' | 'tx_ref_mismatch' };

/**
 * Discover and verify a Flutterwave transaction by its durable tx_ref.
 *
 * Uses bounded date range for the transaction list query, then verifies
 * the discovered transaction by exact ID.
 */
export async function discoverAndVerifyTransaction(
  txRef: string,
  flutterwaveKey: string,
  opts?: { fromDate?: string; toDate?: string }
): Promise<VerifyResult> {
  try {
    // Step 1: Discover candidate transactions with bounded from/to
    const from = opts?.fromDate || new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // default: 48h ago
    const to = opts?.toDate || new Date(Date.now() + 60 * 60 * 1000).toISOString(); // default: 1h in future
    const listUrl = `${FLW_BASE}/v3/transactions?tx_ref=${encodeURIComponent(txRef)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    const listResponse = await fetch(listUrl, {
      headers: { 'Authorization': `Bearer ${flutterwaveKey}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!listResponse.ok) {
      logger.error('[FLW-VERIFY] Transaction list request failed', { status: listResponse.status, txRef });
      return { ok: false, reason: 'unavailable' };
    }

    const listData = await listResponse.json() as { status?: string; data?: { id: number; tx_ref: string }[] };
    if (listData.status !== 'success' || !listData.data) {
      return { ok: false, reason: 'unavailable' };
    }

    // Require unambiguous correlation — exactly one match with correct tx_ref
    const matches = listData.data.filter(tx => tx.tx_ref === txRef);
    if (matches.length === 0) {
      return { ok: false, reason: 'not_found' };
    }
    if (matches.length > 1) {
      logger.error('[FLW-VERIFY] Ambiguous: multiple transactions for tx_ref', { txRef, count: matches.length });
      return { ok: false, reason: 'ambiguous' };
    }

    const candidateId = matches[0].id;

    // Step 2: Verify by exact transaction ID
    const verifyUrl = `${FLW_BASE}/v3/transactions/${candidateId}/verify`;
    const verifyResponse = await fetch(verifyUrl, {
      headers: { 'Authorization': `Bearer ${flutterwaveKey}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!verifyResponse.ok) {
      logger.error('[FLW-VERIFY] Transaction verification request failed', { status: verifyResponse.status, txRef, txId: candidateId });
      return { ok: false, reason: 'verification_failed' };
    }

    const verifyData = await verifyResponse.json() as { status?: string; data?: Record<string, unknown> };
    if (verifyData.status !== 'success' || !verifyData.data) {
      return { ok: false, reason: 'verification_failed' };
    }

    const verified = verifyData.data;

    // Final check: verified tx_ref must match our durable reference
    if (verified.tx_ref !== txRef) {
      logger.error('[FLW-VERIFY] tx_ref mismatch after verification', { expected: txRef, got: verified.tx_ref });
      return { ok: false, reason: 'tx_ref_mismatch' };
    }

    return {
      ok: true,
      tx: {
        id: verified.id as number,
        tx_ref: verified.tx_ref as string,
        status: verified.status as string,
        amount: verified.amount as number,
        currency: ((verified.currency as string) || '').toUpperCase(),
        created_at: verified.created_at as string,
        customer_email: (verified.customer as Record<string, unknown>)?.email as string | undefined,
        app_fee: verified.app_fee as number | undefined,
      },
    };
  } catch (error) {
    logger.error('[FLW-VERIFY] Discovery/verification error', { txRef, error: String(error) });
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * Verify a transaction by its exact provider ID.
 * Used by webhooks after receiving the transaction ID in the payload.
 */
export async function verifyTransactionById(
  txId: number,
  expectedTxRef: string,
  flutterwaveKey: string,
): Promise<VerifyResult> {
  try {
    const verifyUrl = `${FLW_BASE}/v3/transactions/${txId}/verify`;
    const response = await fetch(verifyUrl, {
      headers: { 'Authorization': `Bearer ${flutterwaveKey}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { ok: false, reason: 'verification_failed' };
    }

    const data = await response.json() as { status?: string; data?: Record<string, unknown> };
    if (data.status !== 'success' || !data.data) {
      return { ok: false, reason: 'verification_failed' };
    }

    const verified = data.data;

    // Verify tx_ref matches
    if (verified.tx_ref !== expectedTxRef) {
      logger.error('[FLW-VERIFY] tx_ref mismatch', { expected: expectedTxRef, got: verified.tx_ref });
      return { ok: false, reason: 'tx_ref_mismatch' };
    }

    return {
      ok: true,
      tx: {
        id: verified.id as number,
        tx_ref: verified.tx_ref as string,
        status: verified.status as string,
        amount: verified.amount as number,
        currency: ((verified.currency as string) || '').toUpperCase(),
        created_at: verified.created_at as string,
        customer_email: (verified.customer as Record<string, unknown>)?.email as string | undefined,
        app_fee: verified.app_fee as number | undefined,
      },
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
