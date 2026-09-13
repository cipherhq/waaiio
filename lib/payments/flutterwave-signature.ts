/**
 * Flutterwave webhook signature verification (M378).
 *
 * Supports both:
 * - Current: HMAC-SHA256 via `flutterwave-signature` header (base64 digest)
 * - Legacy: Direct `verif-hash` header comparison against dashboard secret
 */
import { createHmac, timingSafeEqual } from 'crypto';

export function verifyFlutterwaveSignature(
  rawBody: string,
  headers: { verifHash?: string; flutterwaveSignature?: string },
  secretHash: string,
): boolean {
  if (headers.flutterwaveSignature) {
    const computed = createHmac('sha256', secretHash).update(rawBody).digest('base64');
    try {
      return timingSafeEqual(Buffer.from(computed), Buffer.from(headers.flutterwaveSignature));
    } catch {
      return false;
    }
  }
  if (headers.verifHash) {
    try {
      return timingSafeEqual(Buffer.from(headers.verifHash), Buffer.from(secretHash));
    } catch {
      return false;
    }
  }
  return false;
}
