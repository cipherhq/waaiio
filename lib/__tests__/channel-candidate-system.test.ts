/**
 * Channel candidate system tests (#346 R9).
 *
 * Part A: Migration structure + RPC invariants
 * Part B: Route execution tests (OTP + Facebook)
 * Part C: Security, concurrency, onboarding integration
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const migrationSource = readFileSync(join(process.cwd(), 'supabase/migrations/391_channel_candidate_system.sql'), 'utf-8');
const addNumberSource = readFileSync(join(process.cwd(), 'app/api/whatsapp/add-number/route.ts'), 'utf-8');
const fbCallbackSource = readFileSync(join(process.cwd(), 'app/api/auth/facebook/callback/route.ts'), 'utf-8');
const metaCloudSource = readFileSync(join(process.cwd(), 'lib/channels/meta-cloud.ts'), 'utf-8');
const dashboardPageSource = readFileSync(join(process.cwd(), 'app/dashboard/page.tsx'), 'utf-8');
const connectPageSource = readFileSync(join(process.cwd(), 'app/dashboard/whatsapp/connect/page.tsx'), 'utf-8');
const connectionStatusSource = readFileSync(join(process.cwd(), 'app/api/whatsapp/connection-status/route.ts'), 'utf-8');
const stepSuccessSource = readFileSync(join(process.cwd(), 'app/get-started/steps/StepSuccess.tsx'), 'utf-8');

// ═══ Part A: Migration structure ═══

describe('M391 — table structure', () => {
  it('creates candidates with connection_source + business_wa_method (R9 §1)', () => {
    expect(migrationSource).toContain('connection_source');
    expect(migrationSource).toContain("('waaiio_hosted', 'embedded_signup')");
    expect(migrationSource).toContain('business_wa_method');
  });

  it('has phone_number_normalized column', () => {
    expect(migrationSource).toContain('phone_number_normalized');
  });

  it('has partial UNIQUE on business AND phone', () => {
    expect(migrationSource).toContain('uq_candidate_open_per_business');
    expect(migrationSource).toContain('uq_candidate_open_per_phone');
  });

  it('has check_phone_conflict helper RPC', () => {
    expect(migrationSource).toContain('CREATE OR REPLACE FUNCTION public.check_phone_conflict');
    expect(migrationSource).toContain('phone_owned_by_other_business');
    expect(migrationSource).toContain('cross_source_migration_unsupported');
    expect(migrationSource).toContain('legacy_source_requires_support');
  });

  it('creates secrets table with service-only access', () => {
    expect(migrationSource).toContain('whatsapp_channel_secrets');
    expect(migrationSource).toContain('REVOKE ALL ON public.whatsapp_channel_secrets FROM authenticated');
  });

  it('does NOT rewrite connection_status CHECK (H9)', () => {
    expect(migrationSource).not.toContain('whatsapp_channels_connection_status_check');
    expect(migrationSource).toContain("'disconnected'");
  });
});

describe('M391 — promote RPC invariants', () => {
  it('uses scalar UUIDs, not uninitialized RECORDs (R9 §6)', () => {
    expect(migrationSource).toContain('v_old_channel_id         UUID := NULL');
    expect(migrationSource).toContain('v_old_channel_type       TEXT := NULL');
  });

  it('locks business + candidate + old channel FOR UPDATE', () => {
    const rpcBody = migrationSource.slice(migrationSource.indexOf('promote_channel_candidate'));
    expect((rpcBody.match(/FOR UPDATE/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('CAS uses IS DISTINCT FROM', () => {
    expect(migrationSource).toContain('IS DISTINCT FROM v_cand.expected_assigned_channel_id');
    expect(migrationSource).toContain('IS DISTINCT FROM v_cand.expected_whatsapp_channel_id');
    expect(migrationSource).toContain('IS DISTINCT FROM v_cand.expected_wa_method');
  });

  it('NEVER deactivates shared (H1)', () => {
    expect(migrationSource).toContain("v_old_channel_type <> 'dedicated'");
    expect(migrationSource).toContain("'old_channel_not_dedicated'");
  });

  it('writes connection_source to live channel connection_method (R9 §6)', () => {
    expect(migrationSource).toContain('connection_method  = v_cand.connection_source');
  });

  it('writes business_wa_method to business wa_method (R9 §6)', () => {
    expect(migrationSource).toContain('wa_method            = v_cand.business_wa_method');
  });

  it('checks phone conflict before insert (R9 §6)', () => {
    expect(migrationSource).toContain('check_phone_conflict');
    expect(migrationSource).toContain("'phone_conflict'");
  });

  it('upserts encrypted PIN to secrets', () => {
    expect(migrationSource).toContain('INSERT INTO public.whatsapp_channel_secrets');
    expect(migrationSource).toContain('ON CONFLICT (channel_id) DO UPDATE');
  });
});

// ═══ Part B: Route control-flow tests ═══

describe('OTP route — R9 §3 ordering: candidate BEFORE provider mutation', () => {
  it('request phase: candidate INSERT appears before Meta fetch calls in source', () => {
    const requestBlock = addNumberSource.slice(
      addNumberSource.indexOf("action === 'request'") || 0,
      addNumberSource.indexOf("action === 'resend'") || addNumberSource.length,
    );
    const candidateInsertPos = requestBlock.indexOf("from('whatsapp_channel_candidates')");
    const metaFetchPos = requestBlock.indexOf('graph.facebook.com');
    expect(candidateInsertPos).toBeLessThan(metaFetchPos);
  });

  it('request phase: conflict check RPC before candidate creation', () => {
    const requestBlock = addNumberSource.slice(
      addNumberSource.indexOf("action === 'request'") || 0,
      addNumberSource.indexOf("action === 'resend'") || addNumberSource.length,
    );
    const conflictPos = requestBlock.indexOf('check_phone_conflict');
    const candidatePos = requestBlock.indexOf("from('whatsapp_channel_candidates')");
    expect(conflictPos).toBeLessThan(candidatePos);
  });

  it('request phase: candidate status starts as pending', () => {
    expect(addNumberSource).toContain("status: 'pending'");
  });

  it('request phase: uses connection_source waaiio_hosted', () => {
    expect(addNumberSource).toContain("connection_source: 'waaiio_hosted'");
  });

  it('request phase: stores phone_number_normalized', () => {
    expect(addNumberSource).toContain('phone_number_normalized: normalized');
  });

  it('request phase: does not store platform token (H6a)', () => {
    // The OTP candidate insert must set meta_access_token: null
    const requestBlock = addNumberSource.slice(
      addNumberSource.indexOf("action === 'request'") || 0,
      addNumberSource.indexOf("action === 'resend'") || addNumberSource.length,
    );
    expect(requestBlock).toContain('meta_access_token: null');
  });
});

describe('OTP route — R9 §4 UI contract', () => {
  it('verify action requires candidate_id', () => {
    expect(addNumberSource).toContain("!business_id || !otp || !candidate_id");
  });

  it('verify looks up candidate by id + business_id + status=validating', () => {
    const verifyBlock = addNumberSource.slice(addNumberSource.indexOf("action === 'verify'"));
    expect(verifyBlock).toContain(".eq('id', candidate_id)");
    expect(verifyBlock).toContain(".eq('business_id', business_id)");
    expect(verifyBlock).toContain(".eq('status', 'validating')");
  });

  it('verify calls promote_channel_candidate on all-READY', () => {
    const verifyBlock = addNumberSource.slice(addNumberSource.indexOf("action === 'verify'"));
    expect(verifyBlock).toContain("'promote_channel_candidate'");
  });

  it('verify marks candidate failed on registration failure', () => {
    const verifyBlock = addNumberSource.slice(addNumberSource.indexOf("action === 'verify'"));
    expect(verifyBlock).toContain("status: 'failed'");
    expect(verifyBlock).toContain('Phone registration FAILED');
    expect(verifyBlock).toContain('status: 422');
  });

  it('verify marks candidate failed on webhook failure', () => {
    const verifyBlock = addNumberSource.slice(addNumberSource.indexOf("action === 'verify'"));
    expect(verifyBlock).toContain('Webhook subscription FAILED');
  });

  it('resend action exists and reuses candidate', () => {
    expect(addNumberSource).toContain("action === 'resend'");
    const resendBlock = addNumberSource.slice(
      addNumberSource.indexOf("action === 'resend'"),
      addNumberSource.indexOf("action === 'verify'"),
    );
    // Does NOT create a new candidate
    expect(resendBlock).not.toContain('.insert(');
    // Requires candidate_id + business_id
    expect(resendBlock).toContain('candidate_id');
    // Checks source = waaiio_hosted and status = validating
    expect(resendBlock).toContain("'waaiio_hosted'");
    expect(resendBlock).toContain("'validating'");
  });
});

// ═══ Part C: Security, structural, integration ═══

describe('Secure PIN (H7)', () => {
  it('MetaCloudService.registerPhoneNumber requires explicit PIN', () => {
    expect(metaCloudSource).toContain('registerPhoneNumber(pin: string)');
    expect(metaCloudSource).not.toContain("= '000000'");
  });

  it('OTP route uses randomInt, never 000000', () => {
    expect(addNumberSource).toContain('randomInt(100000, 1000000)');
    expect(addNumberSource).not.toContain("pin: '000000'");
  });

  it('Facebook route uses randomInt', () => {
    expect(fbCallbackSource).toContain('randomInt(100000, 1000000)');
  });
});

describe('Privacy (R9 §7)', () => {
  it('status endpoint returns safe failure message, not raw provider errors', () => {
    expect(connectionStatusSource).toContain('failure_message');
    expect(connectionStatusSource).toContain('safeFailureMessage');
    // The JSON response uses failure_message, not raw failure_reason
    expect(connectionStatusSource).toContain('failure_message: candidate.status');
  });

  it('status endpoint returns no tokens', () => {
    expect(connectionStatusSource).not.toContain("'meta_access_token'");
    expect(connectionStatusSource).not.toContain("'encrypted_registration_pin'");
  });

  it('connect page uses status endpoint, not direct candidate table', () => {
    expect(connectPageSource).toContain('/api/whatsapp/connection-status');
    expect(connectPageSource).not.toContain("'whatsapp_channel_candidates'");
  });
});

describe('Dashboard safety', () => {
  it('main page uses is_active filter on assigned channel', () => {
    const linkBlock = dashboardPageSource.slice(
      dashboardPageSource.indexOf('loadWhatsAppLink'),
      dashboardPageSource.indexOf('loadWhatsAppLink') + 500,
    );
    expect(linkBlock).toContain(".eq('is_active', true).maybeSingle()");
  });

  it('connect page stores candidate_id from OTP request (R9 §4)', () => {
    expect(connectPageSource).toContain('setCandidateId(data.candidate_id)');
  });

  it('connect page sends candidate_id in verify (R9 §4)', () => {
    expect(connectPageSource).toContain('candidate_id: candidateId');
  });

  it('resend button uses handleResendOTP, not handleSendOTP', () => {
    expect(connectPageSource).toContain('onClick={handleResendOTP}');
    expect(connectPageSource).toContain('handleResendOTP');
  });

  it('"Do this later" is a real link', () => {
    expect(stepSuccessSource).toContain('href="/dashboard"');
    expect(stepSuccessSource).toContain('Do this later');
  });
});

describe('Cross-source protection (R9 §2)', () => {
  it('OTP route calls check_phone_conflict with waaiio_hosted', () => {
    expect(addNumberSource).toContain("p_connection_source: 'waaiio_hosted'");
  });

  it('Facebook route calls check_phone_conflict with embedded_signup', () => {
    expect(fbCallbackSource).toContain("p_connection_source: 'embedded_signup'");
  });
});

describe('Onboarding integration', () => {
  it('registration route server-enforces wa_method=shared', () => {
    const registerSource = readFileSync(join(process.cwd(), 'app/api/onboarding/register/route.ts'), 'utf-8');
    const insertBlock = registerSource.slice(
      registerSource.indexOf('.insert({'),
      registerSource.indexOf("status: 'pending'") + 20,
    );
    expect(insertBlock).toContain("wa_method: 'shared'");
  });

  it('verify route calls activate_trial_if_eligible', () => {
    const verifySource = readFileSync(join(process.cwd(), 'app/api/onboarding/verify/route.ts'), 'utf-8');
    expect(verifySource).toContain('activate_trial_if_eligible');
  });
});
