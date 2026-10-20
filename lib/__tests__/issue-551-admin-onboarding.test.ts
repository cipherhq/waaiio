import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const createRoute = readFileSync('app/api/admin/onboarding/route.ts', 'utf8');
const actionRoute = readFileSync('app/api/admin/onboarding/[id]/route.ts', 'utf8');
const activationRoute = readFileSync('app/api/onboarding/activate-admin-invite/route.ts', 'utf8');
const service = readFileSync('lib/onboarding/admin-assisted.ts', 'utf8');
const sharedProvisioning = readFileSync('lib/onboarding/provision-business.ts', 'utf8');
const verifyRoute = readFileSync('app/api/onboarding/verify/route.ts', 'utf8');
const migration = readFileSync('supabase/migrations/429_admin_assisted_onboarding.sql', 'utf8');
const publicRegister = readFileSync('app/api/onboarding/register/route.ts', 'utf8');
const adminUi = readFileSync('admin/src/pages/CustomerOnboarding.tsx', 'utf8');

describe('#551 admin-assisted onboarding authority contract', () => {
  it('requires a full platform admin and preserves the public signup gate', () => {
    expect(createRoute).toContain("requiredRole: 'admin'");
    expect(createRoute).toContain("? 403 : 401");
    expect(publicRegister).toContain('isSignupOpen');
    expect(createRoute).not.toContain('isSignupOpen');
  });

  it('shares authoritative country, category, and phone validation with public onboarding', () => {
    expect(publicRegister).toContain("@/lib/onboarding/validation");
    expect(service).toContain("@/lib/onboarding/validation");
  });

  it('keeps service credentials server-side and uses secure auth links without temporary passwords', () => {
    expect(createRoute).toContain("type: 'invite'");
    expect(createRoute).not.toMatch(/password\s*:/);
    expect(adminUi).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(adminUi).not.toContain('action_link');
  });

  it('fails closed on existing email and idempotently keys duplicate requests', () => {
    expect(createRoute).toContain('authUserExists');
    expect(createRoute).toContain('No business was created');
    expect(migration).toContain('UNIQUE (created_by_admin_id, request_key)');
    expect(createRoute).toContain('idempotent: true');
  });

  it('rolls back pending business and auth user if provisioning or invite delivery fails', () => {
    expect(createRoute).toContain(".eq('status', 'pending')");
    expect(createRoute).toContain('service.auth.admin.deleteUser(userId)');
    expect(createRoute).toContain("status: 'failed'");
    expect(createRoute).not.toContain("status: 'active'");
    // Cleanup failures must be explicit — never claim "failed safely" unconditionally
    expect(createRoute).toContain('cleanupFailures');
    expect(createRoute).not.toContain('failed safely');
    // Only null IDs for resources that were actually deleted
    expect(createRoute).toContain('bizCleaned ? null : businessId');
    expect(createRoute).toContain('userCleaned ? null : userId');
  });

  it('provision helper carries businessId in OnboardingProvisionError for deterministic cleanup', () => {
    expect(sharedProvisioning).toContain('OnboardingProvisionError');
    expect(sharedProvisioning).toContain('business.id');
    expect(createRoute).toContain('error instanceof OnboardingProvisionError');
    expect(createRoute).toContain('error.businessId');
  });

  it('partial cancellation persists durable state and writes audit before returning', () => {
    // Cancel path must persist reconciliation state + audit entry before returning partial failure
    expect(actionRoute).toContain('admin_onboarding_cancel_partial');
    expect(actionRoute).toContain('orphaned_user_id');
    expect(actionRoute).toContain("bizCleaned ? null : onboarding.business_id");
  });

  it('records plan intent while forcing actual entitlement to free', () => {
    expect(sharedProvisioning).toContain("subscription_tier: 'free'");
    expect(service).toContain('intended_plan: input.intended_plan');
    expect(activationRoute).toContain("checkout_required: onboarding.intended_plan !== 'free'");
  });

  it('preserves customer-owned consent and provider authorization', () => {
    expect(activationRoute).toContain('consent_preferences');
    expect(activationRoute).toContain('email_confirmed_at');
    expect(sharedProvisioning).toContain("wa_method: 'shared'");
    expect(service).toContain('requested_whatsapp_method');
    expect(activationRoute).toContain("whatsapp_method !== 'shared'");
  });

  it('locks durable onboarding state away from browser roles', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.admin_onboarding_invites FROM anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_onboarding_invites TO service_role');
  });

  it('rate-limits create and resend and audits privileged transitions', () => {
    expect(createRoute).toContain('admin-onboarding-create');
    expect(actionRoute).toContain('admin-onboarding-resend');
    expect(createRoute).toContain('admin_onboarding_create');
    expect(actionRoute).toContain('admin_onboarding_invite_resend');
    expect(actionRoute).toContain('admin_onboarding_cancel');
    expect(actionRoute).toContain('admin_onboarding_retry');
    expect(verifyRoute).toContain('admin_onboarding_activated');
  });

  it('provides a review screen and durable admin queue actions', () => {
    expect(adminUi).toContain('Review before creation');
    expect(adminUi).toContain('Onboarding queue');
    expect(adminUi).toContain("'resend'");
    expect(adminUi).toContain("'cancel'");
  });

  it('enforces operation-bound single-use step-up MFA and dedicated-channel protection on ensure_shared_channel', () => {
    const waAssistanceUi = readFileSync('admin/src/pages/WhatsAppAssistance.tsx', 'utf8');
    expect(actionRoute).toContain('consumeStepUp');
    expect(actionRoute).toContain("'messaging_config'");
    expect(actionRoute).toContain('STEP_UP_REQUIRED');
    expect(actionRoute).toContain('allocateSharedChannelWithFallback');
    expect(actionRoute).toContain('whatsapp_channel_candidates');
    // stepUpId must be extracted from request body and passed as first positional arg
    expect(actionRoute).toContain("body.stepUpId");
    expect(actionRoute).toContain("stepUpId, 'messaging_config'");
    // P1-1: Must use actual M391 candidate states, not invented ones
    expect(actionRoute).toContain("'pending', 'validating', 'ready'");
    expect(actionRoute).not.toContain("'discovered'");
    expect(actionRoute).not.toContain("'verifying'");
    expect(actionRoute).not.toContain("'verified'");
    // P1-2: Must check errors on both dedicated-channel and candidate queries
    expect(actionRoute).toContain('dedicatedErr');
    expect(actionRoute).toContain('candidateErr');
    // P2-2: Must use whatsapp_method (M429 column), not wa_method
    expect(actionRoute).toContain('onboarding.whatsapp_method');
    expect(actionRoute).not.toContain('onboarding.wa_method');
    // P1-3: Race re-verification after step-up
    expect(actionRoute).toContain('raceDedicated');
    expect(actionRoute).toContain('raceCandidate');
    // Client
    expect(waAssistanceUi).toContain('useStepUp');
    expect(waAssistanceUi).toContain('StepUpDialog');
    expect(waAssistanceUi).toContain("actionType: 'messaging_config'");
    expect(waAssistanceUi).toContain("operation: 'ensure_shared_channel'");
    expect(waAssistanceUi).toContain('stepUpId');
  });
});

