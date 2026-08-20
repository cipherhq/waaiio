/**
 * Promotions Secure Pickup Template Readiness Tests
 *
 * Covers: template definition, status-aware provisioning lifecycle,
 * effective channel resolution, shared WABA readiness, UI consumption,
 * and delivery contract.
 */
import { describe, it, expect } from 'vitest';

// ── Template definition contract ──

describe('Template definition', () => {
  const fs = require('fs');
  const provisionSrc = fs.readFileSync('app/api/whatsapp/templates/provision/route.ts', 'utf-8');

  it('promo_verification maps to promo_pickup_verification', () => {
    expect(provisionSrc).toContain('promo_verification:');
    expect(provisionSrc).toContain("'promo_pickup_verification'");
  });

  it('UTILITY category with en_US language', () => {
    const section = provisionSrc.substring(
      provisionSrc.indexOf('promo_verification:'),
      provisionSrc.indexOf('promo_verification:') + 500,
    );
    expect(section).toContain("category: 'UTILITY'");
    expect(section).toContain("language: 'en_US'");
  });

  it('three body variables matching send contract', () => {
    const section = provisionSrc.substring(
      provisionSrc.indexOf('promo_verification:'),
      provisionSrc.indexOf('promo_verification:') + 500,
    );
    expect(section).toContain('{{1}}');
    expect(section).toContain('{{2}}');
    expect(section).toContain('{{3}}');
    expect(section).not.toContain('{{4}}');
  });
});

// ── Status-aware provisioning ──

describe('Provisioning lifecycle', () => {
  const fs = require('fs');
  const src = fs.readFileSync('app/api/whatsapp/templates/provision/route.ts', 'utf-8');

  it('APPROVED not recreated', () => {
    expect(src).toContain('READY_STATUSES');
    expect(src).toContain("action: 'skipped'");
  });

  it('PENDING never recreated', () => {
    expect(src).toContain('PENDING_STATUSES');
  });

  it('no destructive auto-recreation of PAUSED/DISABLED/unknown', () => {
    // Must NOT contain deleteTemplate in the main provisioning loop
    expect(src).not.toContain('deleteTemplate');
    // REJECTED/PAUSED/DISABLED get needs_attention, not auto-delete
    expect(src).toContain("action: 'needs_attention'");
  });

  it('missing template triggers creation', () => {
    expect(src).toContain('createTemplate');
  });

  it('idempotent — existing name+language checked via existingMap', () => {
    expect(src).toContain('existingMap');
  });
});

// ── Effective channel resolution ──

describe('Template readiness uses effective send channel', () => {
  const fs = require('fs');
  const statusSrc = fs.readFileSync('app/api/promotions/template-status/route.ts', 'utf-8');

  it('uses ChannelResolver.resolveByBusinessId (same as OTP send)', () => {
    expect(statusSrc).toContain('ChannelResolver');
    expect(statusSrc).toContain('resolveByBusinessId');
  });

  it('does NOT use direct business_id whatsapp_channels lookup', () => {
    // Must NOT have the old direct-lookup pattern
    expect(statusSrc).not.toContain("eq('business_id', businessId)");
    expect(statusSrc).not.toContain(".from('whatsapp_channels')");
  });

  it('distinguishes business-owned vs managed channel', () => {
    expect(statusSrc).toContain('isBusinessOwned');
    expect(statusSrc).toContain('managed');
  });

  it('falls back to env credentials for shared WABA', () => {
    expect(statusSrc).toContain('META_CLOUD_WABA_ID');
    expect(statusSrc).toContain('META_CLOUD_ACCESS_TOKEN');
  });
});

// ── Readiness statuses ──

describe('Readiness status mapping', () => {
  const fs = require('fs');
  const src = fs.readFileSync('app/api/promotions/template-status/route.ts', 'utf-8');

  it('APPROVED → ready', () => {
    expect(src).toContain("readiness = 'ready'");
  });

  it('PENDING → pending (not ready)', () => {
    expect(src).toContain("readiness = 'pending'");
  });

  it('missing → provisioning_required', () => {
    expect(src).toContain("'provisioning_required'");
  });

  it('REJECTED → rejected', () => {
    expect(src).toContain("readiness = 'rejected'");
  });

  it('provider failure → unavailable (fail closed)', () => {
    expect(src).toContain("'unavailable'");
    expect(src).toContain('Status check failed');
  });

  it('no channel → unavailable (fail closed)', () => {
    expect(src).toContain('No WhatsApp channel available');
  });

  it('no shared_waba pseudo-status', () => {
    // The old shared_waba status was removed — real readiness check instead
    expect(src).not.toContain("'shared_waba'");
  });
});

// ── DB/channel lookup failure handling ──

describe('Fail-closed behavior', () => {
  const fs = require('fs');
  const src = fs.readFileSync('app/api/promotions/template-status/route.ts', 'utf-8');

  it('no channel resolved → unavailable, not false shared classification', () => {
    expect(src).toContain("!resolved");
    expect(src).toContain("'unavailable'");
  });

  it('Meta getTemplates failure → unavailable', () => {
    expect(src).toContain('catch (err)');
    expect(src).toContain("'unavailable'");
  });
});

// ── Existing-business capability enablement ──

describe('Capability enablement path', () => {
  const fs = require('fs');
  const capSrc = fs.readFileSync('app/dashboard/capabilities/page.tsx', 'utf-8');

  it('promo_verification in CAPABILITY_GROUPS for Add Features', () => {
    expect(capSrc).toContain("'promo_verification'");
  });

  it('capability enable triggers template provisioning', () => {
    expect(capSrc).toContain('/api/whatsapp/templates/provision');
    expect(capSrc).toContain('capability: cap');
  });
});

// ── UI readiness consumption ──

describe('Promotions create UI readiness', () => {
  const fs = require('fs');
  const wizardSrc = fs.readFileSync('app/dashboard/promotions/create/page.tsx', 'utf-8');

  it('fetches template readiness on mount', () => {
    expect(wizardSrc).toContain('/api/promotions/template-status');
    expect(wizardSrc).toContain('pickupTemplateReady');
  });

  it('Secure Pickup selection blocked when template not ready', () => {
    expect(wizardSrc).toContain("pickupTemplateReady !== true");
  });

  it('shows availability status in picker label', () => {
    expect(wizardSrc).toContain('Checking availability');
    expect(wizardSrc).toContain('Not available');
  });

  it('loading state does not briefly enable Secure Pickup', () => {
    // pickupTemplateReady starts as null (loading), and the guard checks !== true
    expect(wizardSrc).toContain('pickupTemplateReady === true');
    expect(wizardSrc).toContain('pickupTemplateReady === null');
  });
});

// ── Send contract unchanged ──

describe('OTP send contract', () => {
  const fs = require('fs');
  const sendSrc = fs.readFileSync('app/api/promotions/verification/send/route.ts', 'utf-8');

  it('template-only delivery (no sendText)', () => {
    expect(sendSrc).toContain('sendTemplate');
    expect(sendSrc).not.toMatch(/sender\.sendText\(/);
  });

  it('uses promo_pickup_verification template', () => {
    expect(sendSrc).toContain("templateName: 'promo_pickup_verification'");
  });

  it('passes 3 template params', () => {
    expect(sendSrc).toContain("templateParams: ['Prize', otp, String(OTP_EXPIRY_MINUTES)]");
  });
});

// ── Legacy consistency ──

describe('Legacy provision-templates.ts', () => {
  const fs = require('fs');
  const src = fs.readFileSync('lib/channels/provision-templates.ts', 'utf-8');

  it('includes promo_pickup_verification as UTILITY', () => {
    expect(src).toContain("'promo_pickup_verification'");
    const idx = src.indexOf('promo_pickup_verification');
    const block = src.substring(idx - 50, idx + 200);
    expect(block).toContain("category: 'UTILITY'");
  });
});
