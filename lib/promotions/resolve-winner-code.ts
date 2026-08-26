/**
 * Winner code resolution — defense-in-depth integrity checks.
 *
 * Extracted from the Winners API route so the exact production logic
 * can be tested directly without copying or mocking.
 *
 * Decryption is only permitted when ALL integrity conditions are proven
 * from durable database rows. If any condition fails, returns null.
 * Never exposes ciphertext, hash, or winner-allocation metadata.
 */
import { decryptPromoCode } from '@/lib/promotions/crypto';
import { formatPromoCode, isRoutablePromoCode } from '@/lib/promotions/normalize';

export type CodeJoin = {
  encrypted_code: string | null;
  campaign_id: string;
  status: string;
  outcome: string;
};

/**
 * Resolve the redeemed printed code for a claimed winning redemption.
 *
 * Checks (1-4 are enforced by the caller before invoking this function):
 *   1. Caller passed capability/business authorization.
 *   2. Redemption belongs to the authorized business/campaign.
 *   3. Redemption outcome is 'winner' (query filter).
 *   4. promo_code_id is non-null and resolves to an existing row.
 *
 * This function enforces checks 5-8:
 *   5. Code row campaign_id matches the redemption campaign_id.
 *   6. Code row status is durably 'claimed'.
 *   7. Code row outcome is 'winner' (don't trust redemption outcome alone).
 *   8. Decrypt + validate via isRoutablePromoCode (guards plaintext passthrough).
 */
export function resolveRedeemedCode(
  codeRow: CodeJoin | CodeJoin[] | null,
  redemptionCampaignId: string,
): string | null {
  if (!codeRow) return null;
  const code = Array.isArray(codeRow) ? (codeRow[0] ?? null) : codeRow;
  if (!code) return null;

  // Check 5: code belongs to same campaign as the redemption
  if (code.campaign_id !== redemptionCampaignId) return null;
  // Check 6: code is durably claimed
  if (code.status !== 'claimed') return null;
  // Check 7: code outcome is winner (don't trust redemption outcome alone)
  if (code.outcome !== 'winner') return null;
  // Check 8: decrypt and validate result looks like a real promo code
  if (!code.encrypted_code) return null;
  try {
    const decrypted = decryptPromoCode(code.encrypted_code);
    // Validate the decrypted value is a valid normalized promo code.
    // decryptToken returns the input as-is for non-encrypted strings,
    // so this guards against corrupt/plaintext-passthrough values.
    if (!isRoutablePromoCode(decrypted)) return null;
    return formatPromoCode(decrypted);
  } catch {
    return null;
  }
}
