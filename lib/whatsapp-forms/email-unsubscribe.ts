import { createHmac, timingSafeEqual } from 'crypto';
import { normalizeConsentEmail } from './email-consent';

function secret() {
  const key = process.env.FLOW_TOKEN_SECRET;
  if (!key || key.length < 32) throw new Error('Email unsubscribe signing is unavailable.');
  return key;
}
export function emailUnsubscribeToken(businessId: string, email: string, phone: string): string {
  const payload = Buffer.from(JSON.stringify({ businessId, email, phone })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret()).update(`email-unsubscribe-v1:${payload}`).digest('base64url')}`;
}
export function verifyEmailUnsubscribeToken(token: unknown): { businessId: string; email: string; phone: string } | null {
  if (typeof token !== 'string' || token.length > 1500) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const expected = createHmac('sha256', secret()).update(`email-unsubscribe-v1:${parts[0]}`).digest();
    const signature = Buffer.from(parts[1], 'base64url');
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.businessId)
      || normalizeConsentEmail(value.email) !== value.email || !/^[1-9]\d{6,14}$/.test(value.phone)) return null;
    return value;
  } catch { return null; }
}
