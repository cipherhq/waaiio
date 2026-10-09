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
  it('prevents wizard from launching standard Embedded Signup for coexistence', () => {
    const launch = wizard.slice(wizard.indexOf('function launchWhatsAppSignup()'), wizard.indexOf('window.FB.login(', wizard.indexOf('function launchWhatsAppSignup()')));
    expect(launch).toContain("waMethod === 'coexist'");
    expect(launch).toContain('return;');
  });
});
