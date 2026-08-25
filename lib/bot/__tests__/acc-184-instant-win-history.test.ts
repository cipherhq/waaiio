/**
 * ACC-184: My Instant Win History tests.
 *
 * Tests discoverability, menu visibility, rendering, status safety,
 * tenant isolation, and stale-action handling.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock service client
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: vi.fn(() => {
      const c: Record<string, any> = {};
      c.select = vi.fn().mockReturnValue(c);
      c.eq = vi.fn().mockReturnValue(c);
      c.order = vi.fn().mockReturnValue(c);
      c.limit = vi.fn().mockReturnValue(c);
      c.single = vi.fn().mockResolvedValue({ data: null, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      return c;
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }),
}));

// ══════════════════════════════════════════════════════════
// HISTORY HELPER UNIT TESTS
// ══════════════════════════════════════════════════════════

describe('ACC-184: History helper', () => {
  it('renderPromoHistoryMessage formats winner correctly', async () => {
    const { renderPromoHistoryMessage } = await import('@/lib/promotions/history');
    const msg = renderPromoHistoryMessage([{
      campaignName: 'TROPHY Promo',
      isWinner: true,
      prizeName: 'Cash Prize',
      prizeValue: 5000,
      prizeCurrency: 'NGN',
      claimReference: 'WAA-82H7PQ',
      claimedAt: '2026-08-21T14:30:00Z',
      fulfillmentLabel: '⏳ Pending',
      verificationLabel: '✅ Verified',
    }]);
    expect(msg).toContain('TROPHY Promo');
    expect(msg).toContain('Winner');
    expect(msg).toContain('Cash Prize');
    expect(msg).toContain('NGN 5000');
    expect(msg).toContain('WAA-82H7PQ');
    expect(msg).toContain('⏳ Pending');
    expect(msg).toContain('✅ Verified');
  });

  it('renderPromoHistoryMessage formats try_again correctly (no prize)', async () => {
    const { renderPromoHistoryMessage } = await import('@/lib/promotions/history');
    const msg = renderPromoHistoryMessage([{
      campaignName: 'SCRATCH Promo',
      isWinner: false,
      prizeName: null,
      prizeValue: null,
      prizeCurrency: null,
      claimReference: 'WAA-ABCDEF',
      claimedAt: '2026-08-20T10:00:00Z',
      fulfillmentLabel: '✅ Collected',
      verificationLabel: null,
    }]);
    expect(msg).toContain('SCRATCH Promo');
    expect(msg).toContain('Not a winner');
    expect(msg).not.toContain('Prize');
    expect(msg).not.toContain('Winner');
  });

  it('renderPromoHistoryMessage returns empty message for zero entries', async () => {
    const { renderPromoHistoryMessage } = await import('@/lib/promotions/history');
    const msg = renderPromoHistoryMessage([]);
    expect(msg).toContain("don't have any");
  });

  it('multiple entries sorted newest first are preserved in output', async () => {
    const { renderPromoHistoryMessage } = await import('@/lib/promotions/history');
    const msg = renderPromoHistoryMessage([
      { campaignName: 'Newer', isWinner: true, prizeName: 'Prize A', prizeValue: null, prizeCurrency: null, claimReference: 'R1', claimedAt: '2026-08-22T10:00:00Z', fulfillmentLabel: '⏳ Pending', verificationLabel: null },
      { campaignName: 'Older', isWinner: false, prizeName: null, prizeValue: null, prizeCurrency: null, claimReference: 'R2', claimedAt: '2026-08-20T10:00:00Z', fulfillmentLabel: '✅ Collected', verificationLabel: null },
    ]);
    const newerIdx = msg.indexOf('Newer');
    const olderIdx = msg.indexOf('Older');
    expect(newerIdx).toBeLessThan(olderIdx);
  });
});

// ══════════════════════════════════════════════════════════
// STATUS MAPPING SAFETY
// ══════════════════════════════════════════════════════════

describe('ACC-184: Status mapping safety', () => {
  it('all known fulfillment statuses map to customer-safe labels', async () => {
    // Import the module to access the mapping function indirectly
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/history.ts', 'utf-8');
    // Verify all canonical statuses are mapped
    expect(src).toContain("pending: '⏳ Pending'");
    expect(src).toContain("processing: '🔄 Processing'");
    expect(src).toContain("fulfilled: '✅ Collected'");
    expect(src).toContain("rejected: '❌ Rejected'");
    expect(src).toContain("cancelled: '❌ Cancelled'");
  });

  it('unknown fulfillment status fails closed (not raw)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/history.ts', 'utf-8');
    // The default/fallback must not return the raw status
    expect(src).toContain("|| '⏳ Processing'"); // fail-closed default
  });

  it('unknown verification status fails closed (omitted)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/history.ts', 'utf-8');
    expect(src).toContain('return null; // fail closed');
  });

  it('not_required verification is omitted', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/history.ts', 'utf-8');
    expect(src).toContain("not_required: null");
  });
});

// ══════════════════════════════════════════════════════════
// SAFE DTO CONTRACT
// ══════════════════════════════════════════════════════════

describe('ACC-184: Safe DTO', () => {
  it('getPromoHistory selects only allowlisted fields', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/history.ts', 'utf-8');
    const getHistoryFn = src.split('async function getPromoHistory')[1]?.split('return data')[0] || '';
    // Must include safe fields in select
    expect(getHistoryFn).toContain('outcome');
    expect(getHistoryFn).toContain('claim_reference');
    expect(getHistoryFn).toContain('claimed_at');
    expect(getHistoryFn).toContain('fulfillment_status');
    expect(getHistoryFn).toContain('promo_campaigns');
    expect(getHistoryFn).toContain('promo_prizes');
    // Must NOT select internal fields
    expect(getHistoryFn).not.toContain('promo_code_id');
    expect(getHistoryFn).not.toContain('inbound_message_id');
    expect(getHistoryFn).not.toContain('fulfillment_notes');
    expect(getHistoryFn).not.toContain('fulfilled_by');
    expect(getHistoryFn).not.toContain('verified_by');
  });

  it('rendered output never contains internal identifiers', async () => {
    const { renderPromoHistoryMessage } = await import('@/lib/promotions/history');
    const msg = renderPromoHistoryMessage([{
      campaignName: 'Test', isWinner: true, prizeName: 'Prize',
      prizeValue: 100, prizeCurrency: 'NGN', claimReference: 'WAA-TEST',
      claimedAt: '2026-08-21T10:00:00Z', fulfillmentLabel: '⏳ Pending',
      verificationLabel: '✅ Verified',
    }]);
    // Must not contain raw identifiers
    expect(msg).not.toContain('promo_verification');
    expect(msg).not.toContain('promo_code');
    expect(msg).not.toContain('uuid');
  });
});

// ══════════════════════════════════════════════════════════
// DISCOVERABILITY
// ══════════════════════════════════════════════════════════

describe('ACC-184: Discoverability contracts', () => {
  it('hasHistory promo check uses ctx.from directly (no + prefix)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/capability-selection.flow.ts', 'utf-8');
    // Must call hasPromoHistory with ctx.from (not phoneP which adds +)
    expect(src).toContain('hasPromoHistory(ctx.business.id, ctx.from)');
  });

  it('promo history check is independent of profiles row', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/capability-selection.flow.ts', 'utf-8');
    // Must appear AFTER the profile-based checks (outside the if(profile?.id) block)
    const promoCheckIdx = src.indexOf('hasPromoHistory(ctx.business.id, ctx.from)');
    const profileBlockEnd = src.indexOf('// Build capability items');
    expect(promoCheckIdx).toBeGreaterThan(0);
    expect(promoCheckIdx).toBeLessThan(profileBlockEnd);
  });

  it('My Instant Win History is gated by history existence (not capability)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/capability-selection.flow.ts', 'utf-8');
    // Menu item must use hasPromoHistoryForMenu (not hasCapability)
    expect(src).toContain("show: hasPromoHistoryForMenu");
    // Must NOT gate on capability
    const menuBlock = src.split('My Instant Win History')[1]?.split('},')[0] || '';
    expect(menuBlock).not.toContain("hasCapability('promo_verification')");
  });
});

// ══════════════════════════════════════════════════════════
// STALE ACTION SAFETY
// ══════════════════════════════════════════════════════════

describe('ACC-184: Stale action safety', () => {
  it('acct_promo_history handler exists in validate', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/capability-selection.flow.ts', 'utf-8');
    expect(src).toContain("action === 'acct_promo_history'");
    expect(src).toContain('getPromoHistory');
    expect(src).toContain('renderPromoHistoryMessage');
  });

  it('acct_promo_history routes back to my_account_menu (not booking)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/capability-selection.flow.ts', 'utf-8');
    const promoBlock = src.split("action === 'acct_promo_history'")[1]?.split('// Route to flow steps')[0] || '';
    expect(promoBlock).toContain("_my_account_route: 'my_account_menu'");
    expect(promoBlock).not.toContain('select_service');
    expect(promoBlock).not.toContain('promo_entry');
  });

  it('acct_promo_history shows ← Back button', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/capability-selection.flow.ts', 'utf-8');
    const promoBlock = src.split("action === 'acct_promo_history'")[1]?.split('// Route to flow steps')[0] || '';
    expect(promoBlock).toContain('back_to_account');
  });
});

// ══════════════════════════════════════════════════════════
// TENANT ISOLATION
// ══════════════════════════════════════════════════════════

describe('ACC-184: Tenant isolation', () => {
  it('history helper queries with business_id AND phone_e164', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/history.ts', 'utf-8');
    // Both getPromoHistory and hasPromoHistory must scope by both
    const getBlock = src.split('async function getPromoHistory')[1]?.split('return data')[0] || '';
    expect(getBlock).toContain(".eq('business_id', businessId)");
    expect(getBlock).toContain(".eq('phone_e164', phone)");

    const hasBlock = src.split('async function hasPromoHistory')[1]?.split('return (count')[0] || '';
    expect(hasBlock).toContain(".eq('business_id', businessId)");
    expect(hasBlock).toContain(".eq('phone_e164', phone)");
  });
});

// ══════════════════════════════════════════════════════════
// PROMO_VERIFICATION_ATTEMPTS EXCLUDED
// ══════════════════════════════════════════════════════════

describe('ACC-184: Attempts excluded from history', () => {
  it('history helper queries promo_redemptions only (not attempts)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/history.ts', 'utf-8');
    expect(src).toContain("'promo_redemptions'");
    expect(src).not.toContain('promo_verification_attempts');
  });
});

// ══════════════════════════════════════════════════════════
// CAMPAIGN STATUS NOT FILTERED
// ══════════════════════════════════════════════════════════

describe('ACC-184: Ended/archived campaigns visible', () => {
  it('history query does NOT filter by campaign status', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/history.ts', 'utf-8');
    const queryBlock = src.split('async function getPromoHistory')[1]?.split('return data')[0] || '';
    // Must NOT filter campaign by status (ended/archived must be visible)
    expect(queryBlock).not.toContain("eq('status'");
    expect(queryBlock).not.toContain("status: 'active'");
  });
});

// ══════════════════════════════════════════════════════════
// BOUNDED OUTPUT
// ══════════════════════════════════════════════════════════

describe('ACC-184: Bounded output', () => {
  it('getPromoHistory limits to 10 records', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/history.ts', 'utf-8');
    expect(src).toContain('.limit(10)');
  });

  it('getPromoHistory orders newest first', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/promotions/history.ts', 'utf-8');
    expect(src).toContain("ascending: false");
  });
});

// ══════════════════════════════════════════════════════════
// REGRESSION: Existing My Account unchanged
// ══════════════════════════════════════════════════════════

describe('ACC-184: Existing My Account regression', () => {
  it('My Bookings still exists', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/capability-selection.flow.ts', 'utf-8');
    expect(src).toContain("title: 'My Bookings'");
    expect(src).toContain("postbackText: 'acct_bookings'");
  });

  it('My Orders still exists', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/capability-selection.flow.ts', 'utf-8');
    expect(src).toContain("title: 'My Orders'");
  });

  it('Get Receipt still exists', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/capability-selection.flow.ts', 'utf-8');
    expect(src).toContain("title: 'Get Receipt'");
  });
});
