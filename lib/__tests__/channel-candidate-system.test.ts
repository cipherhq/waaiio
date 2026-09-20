/**
 * Channel candidate system tests (#346 R7).
 *
 * Covers H11 matrix: lifecycle, replacement, CAS, security,
 * provider failures, dashboard safety, onboarding integration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ═══ Source-level structural proofs ═══

const addNumberSource = readFileSync(join(process.cwd(), 'app/api/whatsapp/add-number/route.ts'), 'utf-8');
const fbCallbackSource = readFileSync(join(process.cwd(), 'app/api/auth/facebook/callback/route.ts'), 'utf-8');
const metaCloudSource = readFileSync(join(process.cwd(), 'lib/channels/meta-cloud.ts'), 'utf-8');
const dashboardPageSource = readFileSync(join(process.cwd(), 'app/dashboard/page.tsx'), 'utf-8');
const migrationSource = readFileSync(join(process.cwd(), 'supabase/migrations/391_channel_candidate_system.sql'), 'utf-8');
const connectPageSource = readFileSync(join(process.cwd(), 'app/dashboard/whatsapp/connect/page.tsx'), 'utf-8');
const connectionStatusSource = readFileSync(join(process.cwd(), 'app/api/whatsapp/connection-status/route.ts'), 'utf-8');
const stepSuccessSource = readFileSync(join(process.cwd(), 'app/get-started/steps/StepSuccess.tsx'), 'utf-8');

describe('Channel candidate system — migration structure', () => {
  it('creates whatsapp_channel_candidates table', () => {
    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS public.whatsapp_channel_candidates');
  });

  it('creates whatsapp_channel_secrets table', () => {
    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS public.whatsapp_channel_secrets');
  });

  it('creates promote_channel_candidate RPC as SECURITY DEFINER', () => {
    expect(migrationSource).toContain('CREATE OR REPLACE FUNCTION public.promote_channel_candidate');
    expect(migrationSource).toContain('SECURITY DEFINER');
    expect(migrationSource).toContain("SET search_path = ''");
  });

  it('creates partial UNIQUE INDEX for one open candidate per business', () => {
    expect(migrationSource).toContain('CREATE UNIQUE INDEX uq_candidate_open_per_business');
    expect(migrationSource).toContain("WHERE status IN ('pending', 'validating', 'ready')");
  });

  it('enables RLS on both tables', () => {
    expect(migrationSource).toContain('ALTER TABLE public.whatsapp_channel_candidates ENABLE ROW LEVEL SECURITY');
    expect(migrationSource).toContain('ALTER TABLE public.whatsapp_channel_secrets ENABLE ROW LEVEL SECURITY');
  });

  it('revokes anon/authenticated access from candidate table', () => {
    expect(migrationSource).toContain('REVOKE ALL ON public.whatsapp_channel_candidates FROM anon');
    expect(migrationSource).toContain('REVOKE ALL ON public.whatsapp_channel_candidates FROM authenticated');
  });

  it('revokes anon/authenticated access from secrets table', () => {
    expect(migrationSource).toContain('REVOKE ALL ON public.whatsapp_channel_secrets FROM anon');
    expect(migrationSource).toContain('REVOKE ALL ON public.whatsapp_channel_secrets FROM authenticated');
  });

  it('does NOT add "replaced" to connection_status CHECK (H9: uses existing disconnected)', () => {
    // Migration should not rewrite the production connection_status CHECK
    expect(migrationSource).not.toContain("'replaced'");
    // Uses existing 'disconnected' for superseded channels
    expect(migrationSource).toContain("'disconnected'");
  });

  it('includes self-verification DO block', () => {
    expect(migrationSource).toContain('M391: whatsapp_channel_candidates table not created');
    expect(migrationSource).toContain('M391: whatsapp_channel_secrets table not created');
    expect(migrationSource).toContain('M391: promote_channel_candidate not found');
  });

  it('preserves production provisioning status (F4)', () => {
    // Migration does NOT drop or recreate connection_status CHECK
    expect(migrationSource).not.toContain('DROP CONSTRAINT');
    expect(migrationSource).not.toContain('whatsapp_channels_connection_status_check');
  });
});

describe('Channel candidate system — promote RPC invariants', () => {
  it('locks business FOR UPDATE', () => {
    expect(migrationSource).toContain('FROM public.businesses');
    expect(migrationSource).toContain('FOR UPDATE');
  });

  it('CAS checks use IS DISTINCT FROM (NULL-safe)', () => {
    expect(migrationSource).toContain('IS DISTINCT FROM v_cand.expected_assigned_channel_id');
    expect(migrationSource).toContain('IS DISTINCT FROM v_cand.expected_whatsapp_channel_id');
    expect(migrationSource).toContain('IS DISTINCT FROM v_cand.expected_wa_method');
  });

  it('NEVER deactivates shared channels (H1)', () => {
    // Must check channel_type = dedicated before deactivation
    expect(migrationSource).toContain("v_old_channel.channel_type <> 'dedicated'");
    expect(migrationSource).toContain("'old_channel_not_dedicated'");
  });

  it('validates old channel belongs to same business (H8)', () => {
    expect(migrationSource).toContain('v_old_channel.business_id <> p_business_id');
    expect(migrationSource).toContain("'old_channel_wrong_business'");
  });

  it('validates old channel is active before replacement (H8)', () => {
    expect(migrationSource).toContain('NOT v_old_channel.is_active');
    expect(migrationSource).toContain("'old_channel_not_active'");
  });

  it('handles same-phone reconnect by updating in-place', () => {
    expect(migrationSource).toContain('v_same_phone');
    expect(migrationSource).toContain("'same_phone_update'");
  });

  it('handles different-phone by deactivating old + inserting new', () => {
    expect(migrationSource).toContain("'replace'");
    expect(migrationSource).toContain("connection_status  = 'disconnected'");
  });

  it('handles first connection (no old channel)', () => {
    expect(migrationSource).toContain("'first_connect'");
  });

  it('upserts encrypted PIN to channel secrets', () => {
    expect(migrationSource).toContain('INSERT INTO public.whatsapp_channel_secrets');
    expect(migrationSource).toContain('ON CONFLICT (channel_id) DO UPDATE');
  });

  it('deletes promoted candidate', () => {
    expect(migrationSource).toContain('DELETE FROM public.whatsapp_channel_candidates WHERE id = p_candidate_id');
  });

  it('replacing_dedicated_channel_id uses ON DELETE RESTRICT (H2)', () => {
    expect(migrationSource).toContain('ON DELETE RESTRICT');
  });

  it('RPC is service-role only', () => {
    expect(migrationSource).toContain('REVOKE ALL ON FUNCTION public.promote_channel_candidate');
    expect(migrationSource).toContain('GRANT EXECUTE ON FUNCTION public.promote_channel_candidate');
    expect(migrationSource).toContain('TO service_role');
  });
});

describe('Channel candidate system — secure PIN (H7)', () => {
  it('MetaCloudService.registerPhoneNumber has no default PIN', () => {
    // Must be: registerPhoneNumber(pin: string) — NO default value
    expect(metaCloudSource).toContain('registerPhoneNumber(pin: string)');
    expect(metaCloudSource).not.toContain("registerPhoneNumber(pin: string = '000000')");
  });

  it('OTP route uses randomInt for PIN generation', () => {
    expect(addNumberSource).toContain('randomInt(100000, 999999)');
    expect(addNumberSource).not.toContain("pin: '000000'");
  });

  it('Facebook callback uses randomInt for PIN generation', () => {
    expect(fbCallbackSource).toContain('randomInt(100000, 999999)');
    // Old hardcoded call removed
    expect(fbCallbackSource).not.toContain('registerPhoneNumber()');
  });

  it('PIN is encrypted before storage', () => {
    expect(addNumberSource).toContain('encryptToken(pin)');
    expect(fbCallbackSource).toContain('encryptToken(pin)');
  });
});

describe('Channel candidate system — provider READY gates (H10)', () => {
  it('OTP verify treats registration failure as FATAL', () => {
    // Must mark candidate failed on registration failure
    const verifyBlock = addNumberSource.slice(addNumberSource.indexOf('action === \'verify\''));
    expect(verifyBlock).toContain("status: 'failed'");
    expect(verifyBlock).toContain('Phone registration FAILED');
    expect(verifyBlock).toContain('status: 422');
  });

  it('OTP verify treats webhook failure as FATAL', () => {
    const verifyBlock = addNumberSource.slice(addNumberSource.indexOf('action === \'verify\''));
    expect(verifyBlock).toContain('Webhook subscription FAILED');
  });

  it('Facebook callback treats registration failure as FATAL', () => {
    expect(fbCallbackSource).toContain('Phone registration FAILED');
    expect(fbCallbackSource).toContain("status: 'failed'");
  });

  it('Facebook callback treats webhook failure as FATAL', () => {
    expect(fbCallbackSource).toContain('WABA subscription FAILED');
  });
});

describe('Channel candidate system — routes use candidate table, not live channel', () => {
  it('OTP route creates candidate, not live channel', () => {
    // Request phase inserts into candidates, not whatsapp_channels
    expect(addNumberSource).toContain("from('whatsapp_channel_candidates')");
    expect(addNumberSource).toContain("status: 'validating'");
  });

  it('OTP route does NOT directly update business pointers', () => {
    // No direct business update with assigned_channel_id
    expect(addNumberSource).not.toContain("assigned_channel_id: channel.id");
    // Uses promote RPC instead
    expect(addNumberSource).toContain("'promote_channel_candidate'");
  });

  it('Facebook callback creates candidate, not live channel overwrite', () => {
    expect(fbCallbackSource).toContain("from('whatsapp_channel_candidates')");
    // Old premature business update removed
    expect(fbCallbackSource).not.toContain("assigned_channel_id: channelId");
    expect(fbCallbackSource).not.toContain("whatsapp_channel_id: channelId");
  });

  it('Facebook callback uses promote RPC', () => {
    expect(fbCallbackSource).toContain("'promote_channel_candidate'");
  });

  it('OTP route does NOT store platform token in candidate (H6 option a)', () => {
    // The candidate's meta_access_token should be null for OTP path
    expect(addNumberSource).toContain('meta_access_token: null');
  });

  it('Facebook callback encrypts customer token in candidate (H6)', () => {
    expect(fbCallbackSource).toContain('encryptToken(longLivedToken)');
  });
});

describe('Channel candidate system — cross-method protection (H3)', () => {
  it('OTP route checks for cross-method conflict before provider work', () => {
    // Must check whatsapp_channels for same phone under different method
    const requestBlock = addNumberSource.slice(0, addNumberSource.indexOf("action === 'verify'"));
    expect(requestBlock).toContain('Cross-method check');
    expect(requestBlock).toContain('Cross-method migration is not yet supported');
    expect(requestBlock).toContain('status: 409');
  });

  it('Facebook callback checks for cross-method conflict', () => {
    expect(fbCallbackSource).toContain('Cross-method check');
    expect(fbCallbackSource).toContain('Cross-method migration is not yet supported');
  });
});

describe('Channel candidate system — concurrency (H4)', () => {
  it('OTP route checks for open candidate before creation', () => {
    expect(addNumberSource).toContain('connection attempt is already in progress');
    expect(addNumberSource).toContain('status: 409');
  });

  it('OTP route handles partial UNIQUE index violation', () => {
    expect(addNumberSource).toContain("candErr?.code === '23505'");
  });

  it('Facebook callback checks for open candidate', () => {
    expect(fbCallbackSource).toContain('connection attempt is already in progress');
  });

  it('OTP verify carries candidate_id for lifecycle verification', () => {
    expect(addNumberSource).toContain('candidate_id');
    expect(addNumberSource).toContain('.eq(\'id\', candidate_id)');
  });
});

describe('Channel candidate system — CAS snapshot (H2)', () => {
  it('OTP route captures CAS snapshot at candidate creation', () => {
    expect(addNumberSource).toContain('expected_assigned_channel_id');
    expect(addNumberSource).toContain('expected_whatsapp_channel_id');
    expect(addNumberSource).toContain('expected_wa_method');
    expect(addNumberSource).toContain('replacing_dedicated_channel_id');
  });

  it('Facebook callback captures CAS snapshot at candidate creation', () => {
    expect(fbCallbackSource).toContain('expected_assigned_channel_id');
    expect(fbCallbackSource).toContain('expected_whatsapp_channel_id');
    expect(fbCallbackSource).toContain('expected_wa_method');
    expect(fbCallbackSource).toContain('replacing_dedicated_channel_id');
  });
});

describe('Channel candidate system — dashboard safety', () => {
  it('dashboard page.tsx uses is_active filter on assigned channel query', () => {
    // The assigned channel query at ~line 99 must include is_active filter
    const linkBlock = dashboardPageSource.slice(
      dashboardPageSource.indexOf('loadWhatsAppLink'),
      dashboardPageSource.indexOf('loadWhatsAppLink') + 500,
    );
    // Both the assigned AND dedicated queries must filter is_active
    expect(linkBlock).toContain(".eq('is_active', true).maybeSingle()");
  });

  it('connect page uses connection-status endpoint, not direct candidate table query', () => {
    expect(connectPageSource).toContain('/api/whatsapp/connection-status');
    // Must NOT query whatsapp_channel_candidates directly (H5)
    expect(connectPageSource).not.toContain('whatsapp_channel_candidates');
  });

  it('connection-status endpoint returns no secrets', () => {
    expect(connectionStatusSource).not.toContain('meta_access_token');
    expect(connectionStatusSource).not.toContain('encrypted_registration_pin');
    // Returns safe projection
    expect(connectionStatusSource).toContain('phone_number_display');
    expect(connectionStatusSource).toContain('failure_reason');
  });

  it('connection-status endpoint verifies business ownership', () => {
    expect(connectionStatusSource).toContain("eq('owner_id', user.id)");
  });
});

describe('Channel candidate system — UI (D3 + D5)', () => {
  it('"Do this later" is a real link to /dashboard', () => {
    expect(stepSuccessSource).toContain('href="/dashboard"');
    expect(stepSuccessSource).toContain('Do this later');
    // Must be an <a> tag, not a <span>
    expect(stepSuccessSource).not.toMatch(/<span[^>]*>Do this later<\/span>/);
  });
});

describe('Channel candidate system — onboarding integration', () => {
  it('registration route server-enforces wa_method=shared (C1)', () => {
    const registerSource = readFileSync(
      join(process.cwd(), 'app/api/onboarding/register/route.ts'),
      'utf-8',
    );
    const insertBlock = registerSource.slice(
      registerSource.indexOf('.insert({'),
      registerSource.indexOf("status: 'pending'") + 20,
    );
    expect(insertBlock).toContain("wa_method: 'shared'");
  });

  it('verify route calls activate_trial_if_eligible for free plan', () => {
    const verifySource = readFileSync(
      join(process.cwd(), 'app/api/onboarding/verify/route.ts'),
      'utf-8',
    );
    expect(verifySource).toContain('activate_trial_if_eligible');
  });

  it('subscribe route exists and accepts business_id + plan', () => {
    const subscribeSource = readFileSync(
      join(process.cwd(), 'app/api/onboarding/subscribe/route.ts'),
      'utf-8',
    );
    expect(subscribeSource).toContain('business_id');
    expect(subscribeSource).toContain('plan');
  });
});
