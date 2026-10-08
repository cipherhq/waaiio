/**
 * POST /api/engage/audience/preview
 *
 * Server-authoritative audience preview.
 * Validates a bounded DSL expression, resolves it against business-scoped
 * transactional data, and returns total/channel-eligible counts + a small sample.
 *
 * Authorization: requireCapabilityWithRole(broadcast, create_new, [owner, admin])
 *
 * E1 — preview only. No messages sent, no recipient snapshot materialized.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapabilityWithRole } from '@/lib/capabilities/api-guard';
import { validateAudienceExpression } from '@/lib/engage/audience-dsl';
import { resolveAudienceExpression, AudienceTooLargeError } from '@/lib/engage/audience-resolver';
import { computeAudienceEligibility } from '@/lib/engage/audience-eligibility';

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Parse request
    const body = await request.json();
    const { businessId, expression } = body;

    if (!businessId || typeof businessId !== 'string') {
      return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
    }
    if (!expression) {
      return NextResponse.json({ error: 'expression is required' }, { status: 400 });
    }

    // 3. Authorize: capability + role
    const service = createServiceClient();
    const guard = await requireCapabilityWithRole(service, {
      businessId,
      userId: user.id,
      capability: 'broadcast',
      action: 'create_new',
      allowedRoles: ['owner', 'admin'],
    });

    if (!guard.allowed) {
      return NextResponse.json(guard.denial, { status: guard.status });
    }

    // 4. Validate DSL expression
    const validation = validateAudienceExpression(expression);
    if (!validation.valid) {
      return NextResponse.json(
        { error: 'invalid_expression', details: validation.errors },
        { status: 400 },
      );
    }

    // 5. Load business country for phone normalization
    const { data: business } = await service
      .from('businesses')
      .select('country_code')
      .eq('id', businessId)
      .single();

    const businessCountry = business?.country_code || 'NG';

    // 6. Resolve audience
    const audience = await resolveAudienceExpression(
      service,
      businessId,
      businessCountry,
      expression,
    );

    // 7. Compute eligibility
    const preview = await computeAudienceEligibility(service, businessId, audience);

    return NextResponse.json({
      success: true,
      ...preview,
    });
  } catch (err) {
    if (err instanceof AudienceTooLargeError) {
      return NextResponse.json(
        {
          error: 'audience_too_large',
          message: err.message,
          total: 0,
          whatsappEligible: 0,
          emailEligible: 0,
          sample: [],
        },
        { status: 422 },
      );
    }
    console.error('[engage/audience/preview]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
