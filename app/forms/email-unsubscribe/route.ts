import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyEmailUnsubscribeToken } from '@/lib/whatsapp-forms/email-unsubscribe';

const page = (text: string, status = 200) => new NextResponse(text, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' } });
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  if (!verifyEmailUnsubscribeToken(token)) return page('This unsubscribe link is invalid.', 400);
  // GET is read-only: mail-security link scanners must not unsubscribe customers.
  const safeToken = token!.replace(/[^A-Za-z0-9_.-]/g, '');
  return page(`<html><head><title>Email preferences</title></head><body><h1>Stop marketing emails</h1><p>Unsubscribe this email address from this business.</p><form method="post"><input type="hidden" name="token" value="${safeToken}"><button type="submit">Unsubscribe</button></form></body></html>`);
}
export async function POST(request: NextRequest) {
  let token;
  try { token = (await request.formData()).get('token'); } catch { return page('Invalid request.', 400); }
  const claims = verifyEmailUnsubscribeToken(token);
  if (!claims) return page('This unsubscribe link is invalid.', 400);
  const db = createServiceClient({ noStore: true });
  const { error } = await db.from('native_form_email_unsubscribes').insert({ business_id: claims.businessId, email_address: claims.email });
  // This unique key is the exact business/address, so duplicate means already unsubscribed.
  if (error && error.code !== '23505') return page('Could not save your preference. Please try again.', 503);
  return page('<h1>You are unsubscribed</h1><p>This business will no longer send marketing emails to this address.</p>');
}
