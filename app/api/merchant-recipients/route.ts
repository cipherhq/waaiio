import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { hasRecipientPermission } from '@/lib/merchants/recipient-permission';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponseAsync(getRateLimitKey(request, 'merchant-recipients'), 60, 60_000);
  if (limited) return limited;
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  const q = (request.nextUrl.searchParams.get('q') || '').replace(/[^\p{L}\p{N}+@ .-]/gu, '').trim().slice(0, 80);
  const { service } = auth;
  const businessId = request.nextUrl.searchParams.get('businessId');
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });
  const { data: business, error: businessError } = await service.from('businesses').select('owner_id').eq('id', businessId).maybeSingle();
  if (businessError || !business) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (business.owner_id !== auth.user.id) {
    const { data: member, error: memberError } = await service.from('business_members').select('id').eq('business_id', businessId).eq('user_id', auth.user.id).eq('status', 'active').maybeSingle();
    if (memberError || !member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (q.length < 2) return NextResponse.json({ customers: [] });
  const { data, error } = await service.from('customer_profiles').select('phone, name')
    .eq('business_id', businessId!).or(`name.ilike.%${q}%,phone.ilike.%${q}%`).limit(20);
  if (error) return NextResponse.json({ error: 'Could not load customers' }, { status: 503 });
  const candidates = new Map<string, { phone: string; name: string | null }>();
  for (const row of data || []) if (row.phone) candidates.set(row.phone.replace(/\D/g, ''), row);
  // Opted-in contacts may not yet have a customer profile; permit phone search.
  if (/^\+?\d{2,}$/.test(q)) {
    const { data: contacts, error: consentError } = await service.from('customer_consents').select('phone')
      .eq('business_id', businessId!).eq('channel', 'whatsapp').eq('purpose', 'utility')
      .ilike('phone', `%${q.replace(/\D/g, '')}%`).order('created_at', { ascending: false }).limit(20);
    if (consentError) return NextResponse.json({ error: 'Could not check consent' }, { status: 503 });
    for (const row of contacts || []) if (row.phone && !candidates.has(row.phone.replace(/\D/g, ''))) candidates.set(row.phone.replace(/\D/g, ''), { phone: row.phone, name: null });
  }
  const customers: Array<{ phone: string; name: string | null }> = [];
  const rows = Array.from(candidates.values());
  // Bounded concurrency; send routes recheck permission to catch later revocation.
  for (let i = 0; i < rows.length; i += 5) {
    const eligible = await Promise.all(rows.slice(i, i + 5).map(async row =>
      await hasRecipientPermission(service, businessId!, row.phone, 'utility') ? row : null));
    customers.push(...eligible.filter((row): row is NonNullable<typeof row> => row !== null));
  }
  return NextResponse.json({ customers }, { headers: { 'Cache-Control': 'no-store' } });
}
