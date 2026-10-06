import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function POST(_request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!user.email_confirmed_at) return NextResponse.json({ error: 'Email verification is required' }, { status: 409 });

  const service = createServiceClient({ noStore: true });
  const { data: onboarding } = await service.from('admin_onboarding_invites').select('*')
    .eq('target_user_id', user.id).eq('status', 'customer_action_required').maybeSingle();
  if (!onboarding?.business_id) return NextResponse.json({ error: 'Pending onboarding not found' }, { status: 404 });
  const { data: profile } = await service.from('profiles').select('metadata').eq('id', user.id).maybeSingle();
  const consent = (profile?.metadata as { consent_preferences?: { consented_at?: string; terms_accepted_at?: string } } | null)?.consent_preferences;
  if (!consent?.consented_at || !consent.terms_accepted_at) return NextResponse.json({ error: 'Terms and privacy consent are required' }, { status: 409 });

  const { data: business } = await service.from('businesses').select('id, status, owner_id, subscription_tier')
    .eq('id', onboarding.business_id).eq('owner_id', user.id).maybeSingle();
  if (!business || business.status !== 'pending' || business.subscription_tier !== 'free') {
    return NextResponse.json({ error: 'Pending business is not eligible for activation' }, { status: 409 });
  }
  const { error: auditError } = await service.from('admin_audit_logs').insert({
    actor_id: user.id,
    action: 'admin_onboarding_customer_accepted',
    entity_type: 'admin_onboarding',
    entity_id: onboarding.id,
    details: { target_user_id: user.id, target_email: onboarding.target_email, business_id: onboarding.business_id, customer_accepted: true },
  });
  if (auditError) return NextResponse.json({ error: 'Customer acceptance could not be audited' }, { status: 500 });
  return NextResponse.json({ success: true, business_id: onboarding.business_id, intended_plan: onboarding.intended_plan, checkout_required: onboarding.intended_plan !== 'free', whatsapp_authorization_required: onboarding.whatsapp_method !== 'shared' });
}
