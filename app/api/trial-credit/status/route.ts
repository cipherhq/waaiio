import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';

/**
 * Whether the owner has claimed the free messaging credit, and how much it is,
 * for the dashboard "Claim your free messaging credit" step (Owner decision
 * 2026-11-07). Read-only.
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request, { requireBusinessOwnership: true, businessIdKey: 'business_id' });
  if (auth instanceof NextResponse) return auth;
  const { user, businessId, service } = auth;

  const [{ data: owner }, { data: business }, { data: grant }, { data: trialSetting }, { data: ownedBusinesses }] = await Promise.all([
    service.auth.admin.getUserById(user.id),
    service.from('businesses').select('country_code').eq('id', businessId!).maybeSingle(),
    service.from('messaging_allowances').select('id').eq('business_id', businessId!).eq('type', 'trial_grant').eq('source_ref', 'trial_v2').maybeSingle(),
    service.from('platform_settings').select('value').eq('key', 'trial_credit_minor_by_currency').maybeSingle(),
    service.from('businesses').select('id').eq('owner_id', user.id).neq('id', businessId!),
  ]);

  // M465 gives one free credit per owner: if another of their businesses has
  // it, this one never will, so the page must not promise it.
  let creditedElsewhere = false;
  const otherIds = (ownedBusinesses || []).map(row => (row as { id: string }).id);
  if (!grant && otherIds.length > 0) {
    const { data: otherGrant } = await service.from('messaging_allowances').select('id')
      .in('business_id', otherIds).eq('type', 'trial_grant').eq('source_ref', 'trial_v2').limit(1).maybeSingle();
    creditedElsewhere = !!otherGrant;
  }

  let currency: string | null = null;
  if (business?.country_code) {
    const { data: country } = await service.from('countries').select('currency_code').eq('code', business.country_code).maybeSingle();
    currency = (country?.currency_code as string | undefined) ?? null;
  }
  const amounts = (trialSetting?.value ?? {}) as Record<string, unknown>;
  const amountMinor = currency && typeof amounts[currency] === 'number' ? (amounts[currency] as number) : null;

  return NextResponse.json({
    phone_verified: !!owner?.user?.phone_confirmed_at,
    credited: !!grant,
    owner_already_has_trial: creditedElsewhere,
    amount_minor: amountMinor,
    currency,
  });
}
