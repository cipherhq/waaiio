import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { logAdminAudit } from '@/lib/admin-audit';
import { logger } from '@/lib/logger';
import { FEE_BANK_SETTING_KEY, maskAccountNumber, validateFeeBankValue } from '@/lib/fee-bank-setting';

/**
 * Platform fee bank account (Owner decision 2026-11-06, "extra code required").
 *
 * The bank account behind the platform-fee subaccount that
 * app/api/settings/payment-credentials creates on a merchant's own Paystack account.
 * It is changed only here, by a full admin, after an operation-bound step-up (TOTP) for
 * this exact value. The general platform-settings routes refuse this key.
 */

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin')) });
}

export async function GET(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'));
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const { data, error } = await createServiceClient()
    .from('platform_settings')
    .select('value, updated_at')
    .eq('key', FEE_BANK_SETTING_KEY)
    .maybeSingle();

  if (error) {
    logger.error('[FEE_BANK] read failed', { message: error.message });
    return NextResponse.json({ error: 'Failed to load fee bank account' }, { status: 500, headers: cors });
  }

  const value = (data?.value ?? null) as { bank_code?: string; account_number?: string; account_name?: string } | null;
  return NextResponse.json({
    configured: !!value,
    bank_code: value?.bank_code ?? null,
    account_name: value?.account_name ?? null,
    account_number_masked: value?.account_number ? maskAccountNumber(value.account_number) : null,
    updated_at: data?.updated_at ?? null,
  }, { headers: cors });
}

export async function PUT(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'));
  try {
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
    }

    const validated = validateFeeBankValue(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error, code: 'validation_error' }, { status: 400, headers: cors });
    }
    const value = validated.value;

    const stepUpId = typeof body.stepUpId === 'string' ? body.stepUpId : '';
    try {
      // Bound to this action, this setting and this exact value.
      await consumeStepUp(admin, stepUpId, 'provider_config', FEE_BANK_SETTING_KEY, {
        key: FEE_BANK_SETTING_KEY,
        value,
      });
    } catch (err) {
      const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
      return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403, headers: cors });
    }

    const { error } = await createServiceClient()
      .from('platform_settings')
      .upsert(
        { key: FEE_BANK_SETTING_KEY, value, updated_by: admin.userId, updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      );

    if (error) {
      logger.error('[FEE_BANK] save failed', { message: error.message });
      return NextResponse.json({ error: 'Failed to save fee bank account' }, { status: 500, headers: cors });
    }

    const { error: auditError } = await logAdminAudit({
      actorId: admin.userId,
      action: 'update_platform_fee_bank',
      entityType: 'platform_setting',
      entityId: FEE_BANK_SETTING_KEY,
      details: {
        bank_code: value.bank_code,
        account_name: value.account_name,
        account_number_masked: maskAccountNumber(value.account_number),
        step_up_id: stepUpId,
      },
    });
    if (auditError) {
      logger.error('[FEE_BANK] audit failed', { message: String(auditError) });
      return NextResponse.json({ error: 'Saved but audit failed — contact engineering' }, { status: 500, headers: cors });
    }

    return NextResponse.json({
      success: true,
      bank_code: value.bank_code,
      account_name: value.account_name,
      account_number_masked: maskAccountNumber(value.account_number),
    }, { headers: cors });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
  }
}
