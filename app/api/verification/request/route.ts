import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email/client';
import { kycRequestedEmail } from '@/lib/email/templates';
import { getDocTypeLabel, type CountryCode } from '@/lib/constants';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify admin
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { business_id, requested_level, documents_required, message } = body;

  if (!business_id || !requested_level) {
    return NextResponse.json(
      { error: 'Missing required fields: business_id, requested_level' },
      { status: 400 },
    );
  }

  // Create verification request
  const { data: req, error: insertError } = await supabase
    .from('verification_requests')
    .insert({
      business_id,
      requested_level,
      requested_by: user.id,
      documents_required: documents_required || [],
      message: message || null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (insertError) {
    return NextResponse.json({ error: 'Failed to create request' }, { status: 500 });
  }

  // Update business status to pending
  await supabase
    .from('businesses')
    .update({ verification_status: 'pending' })
    .eq('id', business_id);

  // Send email to business owner
  const { data: biz } = await supabase
    .from('businesses')
    .select('name, owner_id, country_code')
    .eq('id', business_id)
    .single();

  if (biz?.owner_id) {
    const { data: owner } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', biz.owner_id)
      .single();

    if (owner?.email) {
      const levelLabels: Record<string, string> = {
        basic: 'Basic', standard: 'Standard', full: 'Full',
      };
      const cc = (biz.country_code || 'NG') as CountryCode;
      const docNames = (documents_required || []).map((d: string) => getDocTypeLabel(cc, d));
      const email = kycRequestedEmail(biz.name, levelLabels[requested_level] || requested_level, docNames);
      sendEmail({ to: owner.email, ...email }).catch(() => {});
    }
  }

  // Audit log
  await supabase.from('admin_audit_logs').insert({
    actor_id: user.id,
    action: 'request_verification',
    entity_type: 'business',
    entity_id: business_id,
    details: { requested_level, documents_required, request_id: req.id },
  });

  return NextResponse.json({ success: true, request_id: req.id });
}
