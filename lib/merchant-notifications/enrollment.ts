import { createHash, randomBytes } from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { MERCHANT_NOTIFICATION_EVENTS, isMerchantNotificationsEnabled } from './types';

type Database = ReturnType<typeof createServiceClient>;
export const RECIPIENT_FIELDS = 'id,business_id,label,channel,address,events,enabled,verified_at,revoked_at,created_at,whatsapp_channel_id';
export class EnrollmentError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof EnrollmentError ? error.message : 'Notification settings are temporarily unavailable.' }, { status: error instanceof EnrollmentError ? error.status : 503 });
}
export function requireEnabled() {
  if (!isMerchantNotificationsEnabled()) throw new EnrollmentError('Merchant notification setup is not enabled yet.', 503);
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new EnrollmentError('A valid identifier is required.');
  return value;
}
export async function mutationBody(request: NextRequest): Promise<Record<string, unknown>> {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) throw new EnrollmentError('Cross-origin request rejected.', 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new EnrollmentError('JSON is required.', 415);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EnrollmentError('Invalid request.');
  return body;
}
export function normalizeAddress(channel: unknown, address: unknown): string {
  if (typeof address !== 'string' || address.length > 254) throw new EnrollmentError('Enter a valid destination.');
  if (channel === 'email') {
    const email = address.trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new EnrollmentError('Enter a valid email address.');
    return email;
  }
  if (channel !== 'whatsapp' || !address.trim().startsWith('+')) throw new EnrollmentError('Use an international phone number beginning with +.');
  const phone = parsePhoneNumberFromString(address.trim());
  if (!phone?.isValid()) throw new EnrollmentError('Enter a valid international phone number.');
  return phone.number;
}
export function validateEvents(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(event => !MERCHANT_NOTIFICATION_EVENTS.includes(event))) throw new EnrollmentError('Choose valid notification events.');
  return [...new Set(value)];
}
export function validateLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f]/.test(value)) throw new EnrollmentError('Enter a label of 1–80 characters.');
  return value.trim();
}
export const hashInvitation = (token: string) => createHash('sha256').update(token).digest('hex');
export function validToken(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value); }
export function missingSchema(error: { code?: string } | null) { return !!error && ['42P01','PGRST205','PGRST202'].includes(error.code || ''); }
export async function sharedChannel(db: Database, businessId: string) {
  const { data: business, error } = await db.from('businesses').select('country_code').eq('id', businessId).maybeSingle();
  if (error || !business?.country_code) return null;
  const result = await db.from('whatsapp_channels').select('id,phone_number,phone_number_id').eq('country_code', business.country_code).eq('channel_type', 'shared').eq('provider','meta_cloud').eq('is_active',true).maybeSingle();
  return !result.error && result.data?.phone_number_id && result.data.phone_number ? result.data : null;
}
function confirmationOrigin(): string {
  // Server configuration only: never route bearer tokens using request headers.
  const configured = process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.waaiio.com';
  let url: URL;
  try { url = new URL(configured); }
  catch { throw new EnrollmentError('Email confirmation origin is not configured correctly.',503); }
  const hosts = ['www.waaiio.com', 'waaiio.com', 'staging.waaiio.com', 'waaiiostaging-bajides-projects.vercel.app',
    'waaiiostaging-git-codex-merchant-notifications-bajides-projects.vercel.app'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password
    || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new EnrollmentError('Email confirmation origin is not configured correctly.',503);
  }
  return url.origin;
}
export async function issueInvitation(db: Database, businessId: string, recipientId: string) {
  requireEnabled();
  const { data: recipient, error } = await db.from('merchant_notification_recipients').select(RECIPIENT_FIELDS).eq('id',recipientId).eq('business_id',businessId).is('revoked_at',null).maybeSingle();
  if (error) throw error;
  if (!recipient || !recipient.enabled) throw new EnrollmentError('Enabled recipient not found.',404);
  const channel = recipient.channel === 'whatsapp' ? await sharedChannel(db,businessId) : null;
  if (recipient.channel === 'whatsapp' && !channel) throw new EnrollmentError('WhatsApp notifications are not ready for this business.',503);
  if (recipient.channel === 'email' && !process.env.RESEND_API_KEY) throw new EnrollmentError('Email notifications are not configured.',503);
  const business = await db.from('businesses').select('name').eq('id', businessId).maybeSingle();
  if (business.error || !business.data?.name) throw new EnrollmentError('Business details are unavailable.',503);
  const businessName = String(business.data.name).replace(/[\x00-\x1f]/g,' ').slice(0,120);
  const escapedName = businessName.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const emailOrigin = recipient.channel === 'email' ? confirmationOrigin() : null;
  const token = randomBytes(32).toString('base64url');
  const issued = await db.rpc('issue_merchant_notification_invitation', {p_recipient_id:recipientId,p_business_id:businessId,p_token_hash:hashInvitation(token),p_channel_id:channel?.id || null});
  if (issued.error) throw issued.error;
  if (!issued.data?.issued) throw new EnrollmentError('Please wait before sending another confirmation.',429);
  if (channel) return { url:`https://wa.me/${channel.phone_number.replace(/\D/g,'')}?text=${encodeURIComponent(`WAAIIO ALERTS ${token}\nI agree to receive merchant sale, payment, appointment and booking alerts for ${businessName}. Reply STOP to unsubscribe.`)}`, expires_at:issued.data.expires_at };
  const url = `${emailOrigin}/notifications/confirm#token=${token}`;
  const sent = await sendEmail({to:recipient.address,subject:'Confirm Waaiio merchant notifications',html:`<p>You have been invited to receive sale, payment, appointment or booking notifications for <strong>${escapedName}</strong> on Waaiio.</p><p>Confirm only if you want these notifications.</p><p><a href="${url}">Review and confirm notifications</a></p><p>This link expires in 48 hours. If you did not expect this invitation, ignore it.</p>`,noRetry:true});
  if (!sent.success || !('id' in sent) || !sent.id) throw new EnrollmentError('Confirmation email was not accepted. Please try again later.',503);
  return {sent:true,expires_at:issued.data.expires_at};
}
