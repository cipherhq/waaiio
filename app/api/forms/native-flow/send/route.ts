import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { nativeFormsEnabled } from '@/lib/whatsapp-forms/release-gate';
import { ownedNativeForm, nativeError } from '@/lib/whatsapp-forms/owner-access';
import { sendNativeForm } from '@/lib/whatsapp-forms/runtime';
import { rateLimitResponseAsync } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  let body;
  try { body = await request.json(); } catch { return nativeError('Invalid request.', 400); }
  if (!body || typeof body !== 'object') return nativeError('Invalid request.', 400);
  const access = await ownedNativeForm(body.businessId, body.formId);
  if (access.response) return access.response;
  if (!nativeFormsEnabled()) return nativeError('Native WhatsApp forms are not enabled yet.', 503);
  if (typeof body.recipientPhone !== 'string' || !/^\+?[1-9]\d{6,14}$/.test(body.recipientPhone)) return nativeError('A valid phone number is required.', 400);
  const limited = await rateLimitResponseAsync(`native-send:${access.businessId}`, 20, 60_000);
  if (limited) return limited;
  const db = createServiceClient({ noStore: true });
  const resolved = await new ChannelResolver(db).resolveByBusinessId(access.businessId);
  if (!resolved) return nativeError('WhatsApp connection unavailable.');
  try {
    const result = await sendNativeForm({ db, businessId: access.businessId, formId: access.formId, phone: body.recipientPhone, resolved });
    return NextResponse.json(result, { status: result.sent ? 200 : 422, headers: { 'Cache-Control': 'no-store' } });
  } catch { return nativeError('Sending could not be confirmed. Check delivery history before retrying.', 502); }
}
