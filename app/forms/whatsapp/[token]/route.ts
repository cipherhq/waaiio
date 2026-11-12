import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { nativeFormsEnabled } from '@/lib/whatsapp-forms/release-gate';
import { loadCurrentPublication } from '@/lib/whatsapp-forms/runtime';

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const unavailable = () => new NextResponse('This WhatsApp form is not available. Please contact the business.', { status: 404 });
  if (!nativeFormsEnabled() || !/^[A-Za-z0-9_-]{8,20}$/.test(token)) return unavailable();
  const db = createServiceClient({ noStore: true });
  try {
    const { data: form, error } = await db.from('forms').select('id,business_id,is_active').eq('token', token).maybeSingle();
    if (error || !form?.is_active) return unavailable();
    const resolved = await new ChannelResolver(db).resolveByBusinessId(form.business_id);
    if (!resolved || !await loadCurrentPublication(db, form.id, form.business_id, resolved)) return unavailable();
    const number = resolved.channel.phone_number.replace(/\D/g, '');
    if (!/^[1-9]\d{6,14}$/.test(number)) return unavailable();
    return NextResponse.redirect(`https://wa.me/${number}?text=${encodeURIComponent(`waaiio_form:${token}`)}`, { status: 302, headers: { 'Cache-Control': 'no-store' } });
  } catch { return unavailable(); }
}
