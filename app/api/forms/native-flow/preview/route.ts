import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { compileNativeFormFlow, NativeFlowValidationError } from '@/lib/whatsapp-forms/native-flow';

/**
 * GET /api/forms/native-flow/preview?businessId=...&formId=...
 * Owner-only read-only preview; never publishes a Meta Flow or sends a message.
 * The existing forms table is the only source of truth; no second form schema.
 */
export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get('businessId');
  const formId = request.nextUrl.searchParams.get('formId');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!businessId || !formId || !uuid.test(businessId) || !uuid.test(formId)) {
    return NextResponse.json({ error: 'Valid businessId and formId are required.' }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // This route intentionally uses the user-scoped client and explicit owner check.
  const { data: business, error: ownershipError } = await supabase
    .from('businesses').select('id')
    .eq('id', businessId).eq('owner_id', user.id).maybeSingle();
  if (ownershipError) return NextResponse.json({ error: 'Ownership check unavailable' }, { status: 503 });
  if (!business) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data: form, error: formError } = await supabase
    .from('forms').select('id, business_id, title, description, fields')
    .eq('id', formId).eq('business_id', businessId).maybeSingle();
  if (formError) return NextResponse.json({ error: 'Form unavailable' }, { status: 503 });
  if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

  try {
    const flowJson = compileNativeFormFlow(form);
    return NextResponse.json({
      formId: form.id, mode: 'preview_only', flowJson,
      notice: 'Draft JSON only. Meta approval, publication, signed recipient binding and inbound capture are not enabled.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof NativeFlowValidationError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    return NextResponse.json({ error: 'Could not preview Flow' }, { status: 500 });
  }
}
