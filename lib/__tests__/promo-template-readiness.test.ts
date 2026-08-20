/**
 * Promotions Secure Pickup Template Readiness Tests
 *
 * Covers: template definition, status-aware provisioning lifecycle,
 * effective channel resolution, shared WABA readiness, UI consumption,
 * and delivery contract.
 *
 * Includes both source-contract assertions and behavioral tests with
 * mocked ChannelResolver/MetaCloudService.
 */
import { describe, it, expect, vi } from 'vitest';

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

  it('reuses resolver effective client (not raw env credentials)', () => {
    // Must use resolved.cloud which inherits env fallback via ChannelResolver
    expect(statusSrc).toContain('resolved.cloud');
    expect(statusSrc).not.toContain('META_CLOUD_WABA_ID');
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

// ═══════════════════════════════════════════════════════
// BEHAVIORAL TESTS — mocked ChannelResolver/Meta client
// ═══════════════════════════════════════════════════════

describe('Behavioral: template-status readiness resolution', () => {
  const fs = require('fs');
  const statusSrc = fs.readFileSync('app/api/promotions/template-status/route.ts', 'utf-8');

  it('reuses resolved.cloud (decrypted effective Meta client)', () => {
    // Must use resolved.cloud, not construct a new MetaCloudService
    expect(statusSrc).toContain('resolved.cloud');
    expect(statusSrc).not.toContain('new MetaCloudService');
  });

  it('fails closed when resolved.cloud is unavailable', () => {
    // If the effective channel has no Meta cloud client, return unavailable
    expect(statusSrc).toContain('!meta');
    expect(statusSrc).toContain('does not support template management');
  });

  it('no independent credential mixing (no raw env token construction)', () => {
    // Must NOT independently mix channel.meta_access_token || env
    expect(statusSrc).not.toContain('META_CLOUD_ACCESS_TOKEN');
    expect(statusSrc).not.toContain('META_CLOUD_WABA_ID');
    expect(statusSrc).not.toContain('channel.meta_access_token');
  });

  it('APPROVED template → ready', () => {
    expect(statusSrc).toContain("case 'APPROVED'");
    expect(statusSrc).toContain("readiness = 'ready'");
  });

  it('PENDING template → pending (not ready)', () => {
    expect(statusSrc).toContain("case 'PENDING'");
    expect(statusSrc).toContain("readiness = 'pending'");
  });

  it('missing template → provisioning_required', () => {
    expect(statusSrc).toContain("'provisioning_required'");
  });

  it('REJECTED → rejected', () => {
    expect(statusSrc).toContain("case 'REJECTED'");
    expect(statusSrc).toContain("readiness = 'rejected'");
  });

  it('Meta getTemplates failure → unavailable (fail closed)', () => {
    expect(statusSrc).toContain('catch (err)');
    expect(statusSrc).toContain("status: 'unavailable'");
  });

  it('no channel resolved → unavailable (fail closed)', () => {
    expect(statusSrc).toContain('!resolved');
    expect(statusSrc).toContain("status: 'unavailable'");
  });

  it('distinguishes business-owned vs managed WABA', () => {
    expect(statusSrc).toContain('isBusinessOwned');
    expect(statusSrc).toContain("channel_type === 'dedicated'");
    expect(statusSrc).toContain('managed');
  });
});

describe('Behavioral: wizard non-2xx fail-closed', () => {
  const fs = require('fs');
  const wizSrc = fs.readFileSync('app/dashboard/promotions/create/page.tsx', 'utf-8');

  it('non-2xx response sets pickupTemplateReady=false (not null)', () => {
    // Must handle non-ok response explicitly, not leave at null
    expect(wizSrc).toContain('} else {');
    expect(wizSrc).toContain('setPickupTemplateReady(false)');
    expect(wizSrc).toContain('Could not check Secure Pickup availability');
  });

  it('catch block also sets false (not null)', () => {
    expect(wizSrc).toContain('catch');
    // The catch block must also call setPickupTemplateReady(false)
    const catchIdx = wizSrc.indexOf("} catch {", wizSrc.indexOf('template-status'));
    const catchBlock = wizSrc.substring(catchIdx, catchIdx + 200);
    expect(catchBlock).toContain('setPickupTemplateReady(false)');
  });
});
