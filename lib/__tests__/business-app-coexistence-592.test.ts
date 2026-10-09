import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildCoexistenceSignupOptions,
  evaluateBusinessAppCoexistenceConfig,
} from '@/lib/whatsapp/business-app-coexistence';

const valid = {
  enabled: 'true',
  coexistConfigId: '1234567890123456',
  transferConfigId: '6543210987654321',
};

describe('#592 Business App coexistence — executable local readiness gates', () => {
  it('denies opt-in when unset, false, or malformed', () => {
    for (const enabled of [undefined, '', 'false', '1', 'TRUE']) {
      expect(evaluateBusinessAppCoexistenceConfig({ ...valid, enabled })).toMatchObject({
        configured: false, reason: 'disabled',
      });
      expect(() => buildCoexistenceSignupOptions({ ...valid, enabled })).toThrow();
    }
  });

  it('denies missing or invalid Meta-assigned dedicated config ID', () => {
    for (const coexistConfigId of [undefined, '', 'abc', '123']) {
      expect(evaluateBusinessAppCoexistenceConfig({ ...valid, coexistConfigId })).toMatchObject({
        configured: false, reason: 'missing_configuration',
      });
    }
  });

  it('never reuses standard phone-transfer configuration', () => {
    expect(evaluateBusinessAppCoexistenceConfig({
      ...valid, coexistConfigId: valid.transferConfigId,
    })).toMatchObject({ configured: false, reason: 'reused_transfer_configuration' });
  });

  it('configuration readiness is NOT proof that Meta approves number, market or app', () => {
    const gate = evaluateBusinessAppCoexistenceConfig(valid);
    expect(gate).toEqual({
      configured: true, reason: 'provider_verification_required',
      message: expect.stringContaining('Meta must verify'),
    });
    expect(gate).not.toHaveProperty('eligible');
    expect(gate).not.toHaveProperty('canConnect');
  });

  it('builds a separate v4 code-only configuration, no browser token or unauthorized featureType', () => {
    const options = buildCoexistenceSignupOptions(valid);
    expect(options).toEqual({
      config_id: valid.coexistConfigId,
      response_type: 'code',
      override_default_response_type: true,
      extras: {},
    });
    expect(JSON.stringify(options)).not.toContain('access_token');
    expect(JSON.stringify(options)).not.toContain('featureType');
  });

  it('does not infer eligibility from country alone', () => {
    // Even with all config correct, the gate says "provider_verification_required"
    // and never returns an "eligible" or region-based approval
    const gate = evaluateBusinessAppCoexistenceConfig(valid);
    expect(gate.configured).toBe(true);
    expect(gate.reason).toBe('provider_verification_required');
    // The gate has no "eligible" property — config readiness is not eligibility
    expect(gate).not.toHaveProperty('eligible');
    expect(gate).not.toHaveProperty('canConnect');
    expect(gate).not.toHaveProperty('country');
    expect(gate).not.toHaveProperty('region');
    expect(gate).not.toHaveProperty('countryEligible');
  });

  it('treats whitespace-only config ID as missing', () => {
    const result = evaluateBusinessAppCoexistenceConfig({ ...valid, coexistConfigId: '   ' });
    expect(result.configured).toBe(false);
    expect(result.reason).toBe('missing_configuration');
  });
});

describe('#592 legacy callback is fenced from coexistence', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/auth/facebook/callback/route.ts'), 'utf8');
  const wizard = readFileSync(join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'), 'utf8');

  it('rejects coexistence BEFORE token exchange, candidate insert, registerPhoneNumber', () => {
    const fence = route.indexOf("if (connection_method === 'coexist' || connection_method === 'coexistence')");
    expect(fence).toBeGreaterThan(0);
    expect(fence).toBeLessThan(route.indexOf('providedAccessToken) {'));
    expect(fence).toBeLessThan(route.indexOf('registerPhoneNumber(pin)'));
  });

  it('rejects coexistence BEFORE candidate INSERT', () => {
    const fence = route.indexOf("if (connection_method === 'coexist' || connection_method === 'coexistence')");
    const candidateInsert = route.indexOf("'whatsapp_channel_candidates'");
    expect(fence).toBeLessThan(candidateInsert);
  });

  it('rejects unknown connection_method values (not just coexist)', () => {
    // The callback route rejects any connection_method that is not 'transfer' or undefined
    const unknownCheck = route.indexOf("if (connection_method && connection_method !== 'transfer')");
    expect(unknownCheck).toBeGreaterThan(0);
    // This check is AFTER the coexist check but BEFORE any provider mutation
    const coexistFence = route.indexOf("if (connection_method === 'coexist' || connection_method === 'coexistence')");
    expect(unknownCheck).toBeGreaterThan(coexistFence);
    expect(unknownCheck).toBeLessThan(route.indexOf('registerPhoneNumber(pin)'));
  });

  it('standard transfer path is unchanged — no coexistence fence blocks transfer', () => {
    // The coexist fence only fires for 'coexist' or 'coexistence', not 'transfer'
    const fenceBlock = route.slice(
      route.indexOf("if (connection_method === 'coexist'"),
      route.indexOf("if (connection_method && connection_method !== 'transfer')"),
    );
    expect(fenceBlock).not.toContain("'transfer'");
    // The unknown method check explicitly allows 'transfer'
    expect(route).toContain("connection_method !== 'transfer'");
  });

  it('prevents wizard from launching standard Embedded Signup for coexistence', () => {
    const launch = wizard.slice(wizard.indexOf('function launchWhatsAppSignup()'), wizard.indexOf('window.FB.login(', wizard.indexOf('function launchWhatsAppSignup()')));
    expect(launch).toContain("waMethod === 'coexist'");
    expect(launch).toContain('return;');
  });

  it('prevents wizard handleFbConnectAndRegister from executing for coexistence', () => {
    const handler = wizard.slice(
      wizard.indexOf('async function handleFbConnectAndRegister()'),
      wizard.indexOf('async function handleRegister('),
    );
    expect(handler).toContain("waMethod === 'coexist'");
    expect(handler).toContain('return;');
  });

  it('coexist option description warns about Meta-controlled pilot', () => {
    expect(wizard).toContain('Meta-controlled pilot');
    expect(wizard).toContain('coexistence verification');
  });

  it('callback returns 409 with coexistence_not_ready error code', () => {
    expect(route).toContain("error: 'coexistence_not_ready'");
    expect(route).toContain('status: 409');
  });
});

describe('#592 readiness API source contract', () => {
  const readinessRoute = readFileSync(join(process.cwd(), 'app/api/whatsapp/business-app-connect/readiness/route.ts'), 'utf8');

  it('always returns canConnect: false in first slice', () => {
    expect(readinessRoute).toContain('canConnect: false');
  });

  it('requires UUID validation before DB access', () => {
    const uuidCheck = readinessRoute.indexOf('uuid.test(businessId)');
    const dbAccess = readinessRoute.indexOf('.from(');
    expect(uuidCheck).toBeGreaterThan(0);
    expect(uuidCheck).toBeLessThan(dbAccess);
  });

  it('requires auth before exposing any readiness info', () => {
    const authCheck = readinessRoute.indexOf('auth.getUser()');
    // Search for the function CALL (with opening paren), not the import
    const gateEval = readinessRoute.indexOf('evaluateBusinessAppCoexistenceConfig({');
    expect(authCheck).toBeGreaterThan(0);
    expect(gateEval).toBeGreaterThan(0);
    expect(authCheck).toBeLessThan(gateEval);
  });

  it('verifies business ownership before returning config', () => {
    const ownerCheck = readinessRoute.indexOf("eq('owner_id'");
    // Search for the function CALL (with opening paren), not the import
    const gateEval = readinessRoute.indexOf('evaluateBusinessAppCoexistenceConfig({');
    expect(ownerCheck).toBeGreaterThan(0);
    expect(gateEval).toBeGreaterThan(0);
    expect(ownerCheck).toBeLessThan(gateEval);
  });

  it('never makes Meta API calls or provider mutations', () => {
    expect(readinessRoute).not.toContain('graph.facebook.com');
    expect(readinessRoute).not.toContain('registerPhoneNumber');
    expect(readinessRoute).not.toContain('subscribed_apps');
    expect(readinessRoute).not.toContain('createServiceClient');
  });

  it('sets no-store cache header', () => {
    expect(readinessRoute).toContain("'Cache-Control': 'no-store'");
  });
});
