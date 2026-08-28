/**
 * ACC-180: First-message promo routing + provider message ID threading.
 *
 * Tests the agreed architecture:
 * - Trusted business context (pre_resolved, dedicated_number) authorizes first-message promo
 * - Untrusted context (fuzzy, returning_customer) does NOT authorize first-message promo
 * - Restart carries forward original provenance (ACC-204 Blocker 1)
 * - Meta msg.id threaded request-scoped through handleMessage → promo handler
 * - Existing-session promo uses request-scoped messageId (not stale session state)
 * - Promo evaluated before canonical semantic routing
 */
import { describe, it, expect } from 'vitest';

describe('ACC-180: Tenant authority tracking', () => {
  // ACC-204 Blocker 1: Only pre_resolved and dedicated_number are directly trusted.
  // Restart carries forward the original provenance from session_data.biz_resolution.
  const PROMO_TRUSTED: ReadonlySet<string> = new Set(['pre_resolved', 'dedicated_number']);

  it('pre_resolved is trusted for first-message promo', () => {
    expect(PROMO_TRUSTED.has('pre_resolved')).toBe(true);
  });

  it('dedicated_number is trusted for first-message promo', () => {
    expect(PROMO_TRUSTED.has('dedicated_number')).toBe(true);
  });

  it('restart is NOT directly trusted (carries original provenance — ACC-204 Blocker 1)', () => {
    expect(PROMO_TRUSTED.has('restart')).toBe(false);
  });

  it('fuzzy match is NOT trusted', () => {
    expect(PROMO_TRUSTED.has('fuzzy')).toBe(false);
  });

  it('returning_customer is NOT trusted', () => {
    expect(PROMO_TRUSTED.has('returning_customer')).toBe(false);
  });

  it('bot_code (current detection) is NOT trusted', () => {
    expect(PROMO_TRUSTED.has('bot_code')).toBe(false);
  });

  it('null resolution is NOT trusted', () => {
    expect(PROMO_TRUSTED.has(null as unknown as string)).toBe(false);
  });
});

describe('ACC-180: Source code contracts', () => {
  it('handleMessage accepts messageId parameter', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    // Signature includes messageId
    expect(src).toContain('messageId?: string,');
    expect(src).toContain('Provider inbound message ID');
  });

  it('webhook passes metaMsgId to handleMessage', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/webhook/meta-cloud/route.ts', 'utf-8');
    expect(src).toContain('metaMsgId)');
  });

  it('existing-session promo uses request-scoped messageId (not session state)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    // Must pass messageId, not session.session_data.whatsapp_message_id
    const promoSection = src.split('Promo code verification (before keyword matching)')[1]?.split('Unified keyword matching')[0] || '';
    expect(promoSection).toContain('messageId,');
    expect(promoSection).not.toContain('whatsapp_message_id');
  });

  it('first-message promo check exists in new-session path', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    // Must contain the first-message promo block with trusted source check
    expect(src).toContain('PROMO_TRUSTED_SOURCES');
    // ACC-204 Blocker 1: 'restart' removed — restart now carries original provenance
    expect(src).toContain("new Set(['pre_resolved', 'dedicated_number'])");
    // Must check bizResolution
    expect(src).toContain('PROMO_TRUSTED_SOURCES.has(bizResolution)');
  });

  it('first-message promo is placed BEFORE canonical semantic understanding', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    // The promo check must appear before CAS-004 canonical understanding
    const promoIdx = src.indexOf('PROMO_TRUSTED_SOURCES');
    const casIdx = src.indexOf('CAS-004: Canonical first-message understanding pipeline');
    expect(promoIdx).toBeGreaterThan(0);
    expect(casIdx).toBeGreaterThan(0);
    expect(promoIdx).toBeLessThan(casIdx);
  });

  it('first-message promo is placed AFTER capability resolution', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    const promoIdx = src.indexOf('PROMO_TRUSTED_SOURCES');
    const capIdx = src.indexOf('getEffectiveCapabilities');
    // There may be multiple getEffectiveCapabilities calls. The one in the new-session
    // path (inside if (!session || isRestart)) must come before the promo check.
    expect(promoIdx).toBeGreaterThan(capIdx);
  });

  it('first-message promo requires tierInfo.allowed', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    // The promo check condition must include tierInfo?.allowed
    const promoBlock = src.split('ACC-180: First-message promo verification')[1]?.split('Auto-reply')[0] || '';
    expect(promoBlock).toContain('tierInfo?.allowed');
  });

  it('first-message promo uses canonical session path (not ad-hoc insert)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    const promoBlock = src.split('ACC-180: First-message promo verification')[1]?.split('Auto-reply')[0] || '';
    // Promo block must NOT contain its own bot_sessions.insert — it sets a flag instead
    expect(promoBlock).not.toContain('bot_sessions');
    expect(promoBlock).not.toContain('.insert(');
    // Must set promoHandledFirstMessage flag
    expect(promoBlock).toContain('promoHandledFirstMessage = true');
    // Must NOT return early — continues to canonical session creation
    expect(promoBlock).not.toContain('return;');
  });

  it('promoHandledFirstMessage flag skips CAS-004 and returns after canonical session', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    // CAS-004 block must check the flag
    expect(src).toContain('!promoHandledFirstMessage');
    // After canonical session creation, early return for promo-handled
    expect(src).toContain('if (promoHandledFirstMessage)');
  });

  it('bizResolution tracks all resolution paths', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    // Must reference all resolution source types
    expect(src).toContain("'pre_resolved'");
    expect(src).toContain("'restart'");
    expect(src).toContain("bizResolution = 'dedicated_number'");
    expect(src).toContain("bizResolution = 'fuzzy'");
    expect(src).toContain("bizResolution = 'returning_customer'");
  });

  it('no remaining whatsapp_message_id references in promo paths', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    // The old stale session state reference should be fully removed
    expect(src).not.toContain('whatsapp_message_id');
  });

  it('fuzzy detection does not set trusted bizResolution', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    // Detection results set bizResolution to 'fuzzy', which is NOT in trusted set
    expect(src).toContain("bizResolution = 'fuzzy'");
    expect(src).not.toContain("bizResolution = 'exact_bot_code'");
  });
});

describe('ACC-180: Draft campaign exclusion preserved', () => {
  it('hasActiveKeywordCampaign filters on status=active', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/verify.ts', 'utf-8');
    expect(src).toContain(".eq('status', 'active')");
  });

  it('hasActiveBareCodeCampaign filters on status=active', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/verify.ts', 'utf-8');
    const bareSection = src.split('hasActiveBareCodeCampaign')[1] || '';
    expect(bareSection).toContain(".eq('status', 'active')");
  });
});

describe('ACC-180: Capability gating preserved', () => {
  it('promo handler rejects when promo_verification not in capabilities', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/handlers/promo-verification.ts', 'utf-8');
    expect(src).toContain("!effectiveCapabilities.includes('promo_verification')");
    expect(src).toContain('return { handled: false }');
  });

  it('first-message check requires promo_verification in capabilities', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    const promoBlock = src.split('ACC-180: First-message promo verification')[1]?.split('Auto-reply')[0] || '';
    expect(promoBlock).toContain("capabilities.includes('promo_verification'");
  });
});

describe('ACC-180: Provider message ID idempotency', () => {
  it('claim_promo_code accepts p_inbound_message_id', () => {
    const fs = require('fs');
    const sql331 = fs.readFileSync('supabase/migrations/331_promo_winner_security.sql', 'utf-8');
    expect(sql331).toContain('p_inbound_message_id');
    // ON CONFLICT for idempotency
    expect(sql331).toContain('ON CONFLICT (inbound_message_id)');
    expect(sql331).toContain('WHERE inbound_message_id IS NOT NULL');
  });

  it('verifyPromoCode passes inboundMessageId to claim RPC', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/verify.ts', 'utf-8');
    expect(src).toContain('p_inbound_message_id: input.inboundMessageId');
  });

  it('handlePromoVerification passes inboundMessageId from caller', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/handlers/promo-verification.ts', 'utf-8');
    expect(src).toContain('inboundMessageId');
  });
});
