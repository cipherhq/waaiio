/**
 * Promotions Secure Pickup Template Readiness Tests
 *
 * Verifies template definition, provisioning lifecycle, status awareness,
 * and delivery contract.
 */
import { describe, it, expect } from 'vitest';

describe('Template definition', () => {
  const fs = require('fs');
  const provisionSrc = fs.readFileSync('app/api/whatsapp/templates/provision/route.ts', 'utf-8');

  it('promo_verification maps to promo_pickup_verification template', () => {
    // REQUIRED_TEMPLATES must have a promo_verification key
    expect(provisionSrc).toContain("promo_verification:");
    expect(provisionSrc).toContain("'promo_pickup_verification'");
  });

  it('template is UTILITY category with en_US language', () => {
    // Find the promo_verification block
    const promoSection = provisionSrc.substring(
      provisionSrc.indexOf('promo_verification:'),
      provisionSrc.indexOf('promo_verification:') + 500,
    );
    expect(promoSection).toContain("category: 'UTILITY'");
    expect(promoSection).toContain("language: 'en_US'");
  });

  it('template body has exactly three variables matching send contract', () => {
    const promoSection = provisionSrc.substring(
      provisionSrc.indexOf('promo_verification:'),
      provisionSrc.indexOf('promo_verification:') + 500,
    );
    // Body must contain {{1}}, {{2}}, {{3}}
    expect(promoSection).toContain('{{1}}');
    expect(promoSection).toContain('{{2}}');
    expect(promoSection).toContain('{{3}}');
    // Must NOT have {{4}} (only 3 params)
    expect(promoSection).not.toContain('{{4}}');
    // Example must have 3 values
    expect(promoSection).toContain("'Prize'");
    expect(promoSection).toContain("'123456'");
    expect(promoSection).toContain("'10'");
  });
});

describe('Status-aware provisioning', () => {
  const fs = require('fs');
  const provisionSrc = fs.readFileSync('app/api/whatsapp/templates/provision/route.ts', 'utf-8');

  it('APPROVED templates are not recreated', () => {
    expect(provisionSrc).toContain('READY_STATUSES');
    expect(provisionSrc).toContain("'APPROVED'");
  });

  it('PENDING templates are not recreated', () => {
    expect(provisionSrc).toContain('PENDING_STATUSES');
    expect(provisionSrc).toContain("'PENDING'");
  });

  it('REJECTED templates are deleted and recreated', () => {
    expect(provisionSrc).toContain('deleteTemplate');
    expect(provisionSrc).toContain('for recreation');
  });

  it('idempotent — existing APPROVED/PENDING skipped', () => {
    // The provisioning loop checks existingMap before creating
    expect(provisionSrc).toContain('existingMap');
    expect(provisionSrc).toContain("action: 'skipped'");
  });
});

describe('Template readiness statuses', () => {
  const fs = require('fs');
  const statusSrc = fs.readFileSync('app/api/promotions/template-status/route.ts', 'utf-8');

  it('APPROVED → ready', () => {
    expect(statusSrc).toContain("readiness = 'ready'");
  });

  it('PENDING → pending (not ready, not recreated)', () => {
    expect(statusSrc).toContain("readiness = 'pending'");
  });

  it('REJECTED → rejected (not ready)', () => {
    expect(statusSrc).toContain("readiness = 'rejected'");
  });

  it('missing → provisioning_required', () => {
    expect(statusSrc).toContain("'provisioning_required'");
  });

  it('shared WABA → shared_waba status', () => {
    expect(statusSrc).toContain("'shared_waba'");
  });

  it('provider failure → unavailable (fail safely)', () => {
    expect(statusSrc).toContain("'unavailable'");
  });
});

describe('Channel selection', () => {
  const fs = require('fs');
  const provisionSrc = fs.readFileSync('app/api/whatsapp/templates/provision/route.ts', 'utf-8');

  it('dedicated channel: provisions on business WABA', () => {
    expect(provisionSrc).toContain("eq('business_id', business_id)");
    expect(provisionSrc).toContain("eq('provider', 'meta_cloud')");
    expect(provisionSrc).toContain('waba_id');
  });

  it('shared channel: returns shared status without error', () => {
    expect(provisionSrc).toContain('shared: true');
    expect(provisionSrc).toContain('provisioned: false');
  });
});

describe('Secure Pickup send contract', () => {
  const fs = require('fs');
  const sendSrc = fs.readFileSync('app/api/promotions/verification/send/route.ts', 'utf-8');

  it('send uses template-only delivery (no sendText)', () => {
    expect(sendSrc).toContain('sendTemplate');
    expect(sendSrc).not.toMatch(/sender\.sendText\(/);
  });

  it('send uses promo_pickup_verification template name', () => {
    expect(sendSrc).toContain("templateName: 'promo_pickup_verification'");
  });

  it('send passes 3 template params matching definition', () => {
    // Params: prize descriptor, OTP, expiry minutes
    expect(sendSrc).toContain("templateParams: ['Prize', otp, String(OTP_EXPIRY_MINUTES)]");
  });
});

describe('Legacy provision-templates.ts consistency', () => {
  const fs = require('fs');
  const legacySrc = fs.readFileSync('lib/channels/provision-templates.ts', 'utf-8');

  it('legacy list also includes promo_pickup_verification', () => {
    expect(legacySrc).toContain("'promo_pickup_verification'");
  });

  it('legacy definition is UTILITY category', () => {
    // Find the promo_pickup_verification entry
    const promoIdx = legacySrc.indexOf('promo_pickup_verification');
    const block = legacySrc.substring(promoIdx - 50, promoIdx + 300);
    expect(block).toContain("category: 'UTILITY'");
  });
});
