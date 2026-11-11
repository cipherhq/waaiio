import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { DEFAULT_TAX_SETTINGS, parseTaxSettings } from '@/lib/tax/settings';

type Context = { params: Promise<{ id: string }> };

async function authorize(context: Context) {
  const { id } = await context.params;
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const { data: business, error } = await db.from('businesses').select('id')
    .eq('id', id).eq('owner_id', user.id).maybeSingle();
  if (error) return { response: NextResponse.json({ error: 'Unable to load business' }, { status: 503 }) };
  if (!business) return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { db, businessId: id };
}

export async function GET(_request: NextRequest, context: Context) {
  const access = await authorize(context);
  if (access.response) return access.response;
  const { data, error } = await access.db!.from('merchant_tax_settings')
    .select('*').eq('business_id', access.businessId!).maybeSingle();
  if (error) return NextResponse.json({ error: 'Unable to load tax settings' }, { status: 503 });
  return NextResponse.json({ settings: data ? parseTaxSettings(data) : DEFAULT_TAX_SETTINGS });
}

export async function PUT(request: NextRequest, context: Context) {
  const access = await authorize(context);
  if (access.response) return access.response;
  let settings: ReturnType<typeof parseTaxSettings>;
  try { settings = parseTaxSettings(await request.json()); }
  catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid tax settings' }, { status: 400 });
  }
  const { error } = await access.db!.from('merchant_tax_settings').upsert({
    ...settings, business_id: access.businessId!, updated_at: new Date().toISOString(),
  }, { onConflict: 'business_id' });
  if (error) return NextResponse.json({ error: 'Unable to save tax settings' }, { status: 503 });
  return NextResponse.json({ settings });
}
