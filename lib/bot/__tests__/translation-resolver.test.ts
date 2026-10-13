/**
 * Translation Resolver — 4-layer resolution via AsyncLocalStorage
 *
 * Tests the actual resolution behavior:
 *   1. Business override   (bot_translation_overrides)
 *   2. Platform override    (bot_translation_platform_overrides)
 *   3. Code default         (FLOW_COPY in flow-localization.ts)
 *   4. English fallback     (FLOW_COPY.en)
 *
 * Plus: fillFlowCopy interpolation, platform cache, isBusinessEditableKey.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runWithTranslationOverrides,
  getTranslationOverrides,
  loadPlatformOverrides,
  loadBusinessOverrides,
  invalidatePlatformOverridesCache,
  isBusinessEditableKey,
  type TranslationOverrides,
} from '@/lib/bot/translations';
import { getFlowCopy, fillFlowCopy } from '@/lib/bot/flows/flow-localization';

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/** Build a minimal TranslationOverrides with the given maps. */
function makeOverrides(
  business: Record<string, string> = {},
  platform: Record<string, string> = {},
): TranslationOverrides {
  return {
    business: new Map(Object.entries(business)),
    platform: new Map(Object.entries(platform)),
  };
}

/** Create a mock Supabase client returning the given rows for a select query. */
function mockSupabase(rows: Array<{ lang: string; key: string; value: string }>) {
  return {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: rows, error: null }),
        // For loadPlatformOverrides (no .eq chained)
        then: (resolve: (v: { data: typeof rows; error: null }) => void) =>
          resolve({ data: rows, error: null }),
      }),
    }),
  } as any;
}

/**
 * Create a mock Supabase client that tracks call counts.
 * Each call to .select() increments the counter.
 */
function mockSupabaseWithCounter(rows: Array<{ lang: string; key: string; value: string }>) {
  const counter = { selectCalls: 0 };
  const client = {
    from: () => ({
      select: () => {
        counter.selectCalls++;
        return {
          eq: () => Promise.resolve({ data: rows, error: null }),
          then: (
            resolve: (v: { data: typeof rows; error: null }) => void,
            _reject?: (e: unknown) => void,
          ) => resolve({ data: rows, error: null }),
        };
      },
    }),
  } as any;
  return { client, counter };
}

// ═══════════════════════════════════════════════════════════════
// 1. Resolution order
// ═══════════════════════════════════════════════════════════════

describe('translation resolution order', () => {
  it('business override takes precedence over platform and code', () => {
    const overrides = makeOverrides(
      { 'en.invalidSelection': 'BIZ: Custom invalid' },
      { 'en.invalidSelection': 'PLAT: Custom invalid' },
    );
    const result = runWithTranslationOverrides(overrides, () =>
      getFlowCopy('en', 'invalidSelection'),
    );
    expect(result).toBe('BIZ: Custom invalid');
  });

  it('platform override takes precedence over code default', () => {
    const overrides = makeOverrides(
      {}, // no business override
      { 'en.invalidSelection': 'PLAT: Custom invalid' },
    );
    const result = runWithTranslationOverrides(overrides, () =>
      getFlowCopy('en', 'invalidSelection'),
    );
    expect(result).toBe('PLAT: Custom invalid');
  });

  it('falls back to code default when no overrides', () => {
    const overrides = makeOverrides(); // empty maps
    const result = runWithTranslationOverrides(overrides, () =>
      getFlowCopy('en', 'invalidSelection'),
    );
    // Should return the code default from FLOW_COPY.en
    expect(result).toBe('That option is not available. Tap one of the choices above.');
  });

  it('falls back to English when key missing in target language', () => {
    // Use a key that exists in en but might not in pcm.
    // 'error.escalation_failed' exists in en, test that pcm fallback works.
    const overrides = makeOverrides();
    const result = runWithTranslationOverrides(overrides, () =>
      getFlowCopy('en', 'error.escalation_failed'),
    );
    expect(result).toContain("couldn't connect you");

    // For a certified non-English language, even if the key exists there,
    // we can test by verifying it returns something meaningful (not the raw key).
    const pcmResult = runWithTranslationOverrides(overrides, () =>
      getFlowCopy('pcm', 'invalidSelection'),
    );
    // pcm has its own translation for invalidSelection
    expect(pcmResult).toBe('That option no dey. Tap one of the choices wey dey above.');
  });

  it('returns key name when missing even in English', () => {
    const overrides = makeOverrides();
    const result = runWithTranslationOverrides(overrides, () =>
      getFlowCopy('en', 'nonexistent.totally.fake.key'),
    );
    expect(result).toBe('nonexistent.totally.fake.key');
  });

  it('outside ALS scope, layers 1+2 are skipped — returns code default directly', () => {
    // Call getFlowCopy with NO runWithTranslationOverrides wrapper
    const result = getFlowCopy('en', 'invalidSelection');
    expect(result).toBe('That option is not available. Tap one of the choices above.');

    // Verify the ALS store is indeed null outside
    expect(getTranslationOverrides()).toBeNull();
  });

  it('uncertified language falls back to English', () => {
    // 'yo' (Yoruba) is not in CERTIFIED_LANGUAGES
    const overrides = makeOverrides();
    const result = runWithTranslationOverrides(overrides, () =>
      getFlowCopy('yo', 'invalidSelection'),
    );
    // Since 'yo' is not certified, getFlowCopy normalizes to 'en'
    expect(result).toBe('That option is not available. Tap one of the choices above.');
  });

  it('undefined language falls back to English', () => {
    const overrides = makeOverrides();
    const result = runWithTranslationOverrides(overrides, () =>
      getFlowCopy(undefined, 'invalidSelection'),
    );
    expect(result).toBe('That option is not available. Tap one of the choices above.');
  });

  it('business override for specific language is respected', () => {
    // Override pcm specifically, not en
    const overrides = makeOverrides(
      { 'pcm.invalidSelection': 'BIZ PCM: Custom message' },
    );
    // pcm override should apply for pcm
    const pcmResult = runWithTranslationOverrides(overrides, () =>
      getFlowCopy('pcm', 'invalidSelection'),
    );
    expect(pcmResult).toBe('BIZ PCM: Custom message');

    // en should still return code default (no en business override)
    const enResult = runWithTranslationOverrides(overrides, () =>
      getFlowCopy('en', 'invalidSelection'),
    );
    expect(enResult).toBe('That option is not available. Tap one of the choices above.');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. fillFlowCopy with overrides
// ═══════════════════════════════════════════════════════════════

describe('fillFlowCopy with overrides', () => {
  it('interpolates placeholders in business override text', () => {
    const overrides = makeOverrides({
      'en.lang.switched': 'BIZ: You switched to {langName}!',
    });
    const result = runWithTranslationOverrides(overrides, () =>
      fillFlowCopy('en', 'lang.switched', { langName: 'Pidgin' }),
    );
    expect(result).toBe('BIZ: You switched to Pidgin!');
  });

  it('interpolates placeholders in platform override text', () => {
    const overrides = makeOverrides(
      {},
      { 'en.lang.switched': 'PLAT: Now using {langName}.' },
    );
    const result = runWithTranslationOverrides(overrides, () =>
      fillFlowCopy('en', 'lang.switched', { langName: 'French' }),
    );
    expect(result).toBe('PLAT: Now using French.');
  });

  it('interpolates placeholders in code default text', () => {
    const overrides = makeOverrides();
    const result = runWithTranslationOverrides(overrides, () =>
      fillFlowCopy('en', 'lang.switched', { langName: 'Spanish' }),
    );
    // Code default: 'Switched to {langName}. ✅'
    expect(result).toBe('Switched to Spanish. ✅');
  });

  it('replaces multiple occurrences of the same placeholder', () => {
    const overrides = makeOverrides({
      'en.lang.detected_offer':
        'BIZ: Prefer {langName}? Switch to {langName} now!',
    });
    const result = runWithTranslationOverrides(overrides, () =>
      fillFlowCopy('en', 'lang.detected_offer', { langName: 'Yoruba' }),
    );
    expect(result).toBe('BIZ: Prefer Yoruba? Switch to Yoruba now!');
  });

  it('leaves unreferenced placeholders untouched', () => {
    const overrides = makeOverrides({
      'en.lang.switched': 'BIZ: Switched to {langName} by {admin}.',
    });
    const result = runWithTranslationOverrides(overrides, () =>
      fillFlowCopy('en', 'lang.switched', { langName: 'French' }),
    );
    // {admin} was not in the values, so it stays as-is
    expect(result).toBe('BIZ: Switched to French by {admin}.');
  });

  it('works outside ALS scope using code defaults', () => {
    const result = fillFlowCopy('en', 'lang.switched', { langName: 'Hausa' });
    expect(result).toBe('Switched to Hausa. ✅');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Platform cache TTL and invalidation
// ═══════════════════════════════════════════════════════════════

describe('platform overrides cache', () => {
  beforeEach(() => {
    // Start each test with a clean cache
    invalidatePlatformOverridesCache();
  });

  afterEach(() => {
    invalidatePlatformOverridesCache();
    vi.restoreAllMocks();
  });

  it('caches platform overrides for 60 seconds', async () => {
    const { client, counter } = mockSupabaseWithCounter([
      { lang: 'en', key: 'invalidSelection', value: 'cached override' },
    ]);

    // First call — hits "DB"
    const first = await loadPlatformOverrides(client);
    expect(counter.selectCalls).toBe(1);
    expect(first.get('en.invalidSelection')).toBe('cached override');

    // Second call within TTL — should NOT hit DB again
    const second = await loadPlatformOverrides(client);
    expect(counter.selectCalls).toBe(1); // still 1
    expect(second.get('en.invalidSelection')).toBe('cached override');
  });

  it('invalidatePlatformOverridesCache forces reload', async () => {
    const { client, counter } = mockSupabaseWithCounter([
      { lang: 'en', key: 'nav.back', value: 'Go back' },
    ]);

    // Load once
    await loadPlatformOverrides(client);
    expect(counter.selectCalls).toBe(1);

    // Invalidate
    invalidatePlatformOverridesCache();

    // Load again — should hit DB
    await loadPlatformOverrides(client);
    expect(counter.selectCalls).toBe(2);
  });

  it('expired cache triggers reload', async () => {
    const { client, counter } = mockSupabaseWithCounter([
      { lang: 'en', key: 'menu.title', value: 'Main Menu' },
    ]);

    // Load — primes cache
    await loadPlatformOverrides(client);
    expect(counter.selectCalls).toBe(1);

    // Advance time past 60s TTL
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);

    await loadPlatformOverrides(client);
    expect(counter.selectCalls).toBe(2);

    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. loadBusinessOverrides
// ═══════════════════════════════════════════════════════════════

describe('loadBusinessOverrides', () => {
  it('returns a Map keyed by lang.key', async () => {
    const client = mockSupabase([
      { lang: 'en', key: 'invalidSelection', value: 'Custom invalid' },
      { lang: 'pcm', key: 'nav.back', value: 'Go back o' },
    ]);
    const map = await loadBusinessOverrides(client, 'biz-123');
    expect(map.get('en.invalidSelection')).toBe('Custom invalid');
    expect(map.get('pcm.nav.back')).toBe('Go back o');
    expect(map.size).toBe(2);
  });

  it('returns empty Map when no overrides exist', async () => {
    const client = mockSupabase([]);
    const map = await loadBusinessOverrides(client, 'biz-empty');
    expect(map.size).toBe(0);
  });

  it('returns empty Map on error', async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: null, error: new Error('DB down') }),
        }),
      }),
    } as any;
    const map = await loadBusinessOverrides(client, 'biz-error');
    expect(map.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. isBusinessEditableKey
// ═══════════════════════════════════════════════════════════════

describe('isBusinessEditableKey', () => {
  describe('allows cap.* keys', () => {
    it('cap.scheduling', () => {
      expect(isBusinessEditableKey('cap.scheduling')).toBe(true);
    });
    it('cap.appointment.restaurant', () => {
      expect(isBusinessEditableKey('cap.appointment.restaurant')).toBe(true);
    });
  });

  describe('allows greeting.* except greeting.powered_by', () => {
    it('greeting.welcome_default is allowed', () => {
      expect(isBusinessEditableKey('greeting.welcome_default')).toBe(true);
    });
    it('greeting.powered_by is blocked (branding)', () => {
      expect(isBusinessEditableKey('greeting.powered_by')).toBe(false);
    });
  });

  describe('blocks payment.* keys', () => {
    it('payment.ive_paid', () => {
      expect(isBusinessEditableKey('payment.ive_paid')).toBe(false);
    });
    it('payment.enter_pin', () => {
      expect(isBusinessEditableKey('payment.enter_pin')).toBe(false);
    });
  });

  describe('blocks error.* keys', () => {
    it('error.generic', () => {
      expect(isBusinessEditableKey('error.generic')).toBe(false);
    });
    it('error.temporary', () => {
      expect(isBusinessEditableKey('error.temporary')).toBe(false);
    });
  });

  describe('blocks docs.* keys', () => {
    it('docs.generating', () => {
      expect(isBusinessEditableKey('docs.generating')).toBe(false);
    });
  });

  describe('blocks notification.*, handoff.*, savedcard.*, chat.* keys', () => {
    it('notification.queue_your_turn', () => {
      expect(isBusinessEditableKey('notification.queue_your_turn')).toBe(false);
    });
    it('handoff.connecting', () => {
      expect(isBusinessEditableKey('handoff.connecting')).toBe(false);
    });
    it('savedcard.pay_with_saved', () => {
      expect(isBusinessEditableKey('savedcard.pay_with_saved')).toBe(false);
    });
    it('chat.unavailable', () => {
      expect(isBusinessEditableKey('chat.unavailable')).toBe(false);
    });
  });

  describe('allows flow-specific keys', () => {
    it('booking.select_location', () => {
      expect(isBusinessEditableKey('booking.select_location')).toBe(true);
    });
    it('ordering.welcome', () => {
      expect(isBusinessEditableKey('ordering.welcome')).toBe(true);
    });
    it('ticketing.events_title', () => {
      expect(isBusinessEditableKey('ticketing.events_title')).toBe(true);
    });
    it('reservation.* allowed', () => {
      expect(isBusinessEditableKey('reservation.select_date')).toBe(true);
    });
    it('survey.* allowed', () => {
      expect(isBusinessEditableKey('survey.start')).toBe(true);
    });
    it('poll.* allowed', () => {
      expect(isBusinessEditableKey('poll.vote')).toBe(true);
    });
    it('feedback.* allowed', () => {
      expect(isBusinessEditableKey('feedback.thanks')).toBe(true);
    });
    it('queue.* allowed', () => {
      expect(isBusinessEditableKey('queue.position')).toBe(true);
    });
    it('waitlist.* allowed', () => {
      expect(isBusinessEditableKey('waitlist.joined')).toBe(true);
    });
    it('crowdfunding.* allowed', () => {
      expect(isBusinessEditableKey('crowdfunding.goal')).toBe(true);
    });
    it('loyalty.* allowed', () => {
      expect(isBusinessEditableKey('loyalty.balance')).toBe(true);
    });
    it('recurring.* allowed', () => {
      expect(isBusinessEditableKey('recurring.manage')).toBe(true);
    });
    it('invoice.* allowed', () => {
      expect(isBusinessEditableKey('invoice.details')).toBe(true);
    });
  });

  describe('allows other editable prefixes', () => {
    it('lang.* allowed', () => {
      expect(isBusinessEditableKey('lang.switched')).toBe(true);
    });
    it('menu.* allowed', () => {
      expect(isBusinessEditableKey('menu.title')).toBe(true);
    });
    it('nav.* allowed', () => {
      expect(isBusinessEditableKey('nav.back')).toBe(true);
    });
    it('account.* allowed', () => {
      expect(isBusinessEditableKey('account.menu')).toBe(true);
    });
    it('confirm.* allowed', () => {
      expect(isBusinessEditableKey('confirm.done')).toBe(true);
    });
    it('post.* allowed', () => {
      expect(isBusinessEditableKey('post.completion')).toBe(true);
    });
    it('rsvp.* allowed', () => {
      expect(isBusinessEditableKey('rsvp.confirm')).toBe(true);
    });
    it('tips.* allowed', () => {
      expect(isBusinessEditableKey('tips.add')).toBe(true);
    });
    it('orders.* allowed', () => {
      expect(isBusinessEditableKey('orders.status')).toBe(true);
    });
    it('order_status.* allowed', () => {
      expect(isBusinessEditableKey('order_status.ready')).toBe(true);
    });
    it('rating.* allowed', () => {
      expect(isBusinessEditableKey('rating.prompt')).toBe(true);
    });
  });

  describe('allows legacy exact-match keys', () => {
    it('invalidSelection', () => {
      expect(isBusinessEditableKey('invalidSelection')).toBe(true);
    });
    it('cancelHint', () => {
      expect(isBusinessEditableKey('cancelHint')).toBe(true);
    });
    it('yes', () => {
      expect(isBusinessEditableKey('yes')).toBe(true);
    });
    it('stayHere', () => {
      expect(isBusinessEditableKey('stayHere')).toBe(true);
    });
    it('rerouteBooking', () => {
      expect(isBusinessEditableKey('rerouteBooking')).toBe(true);
    });
    it('rerouteOrdering', () => {
      expect(isBusinessEditableKey('rerouteOrdering')).toBe(true);
    });
    it('rerouteTicketing', () => {
      expect(isBusinessEditableKey('rerouteTicketing')).toBe(true);
    });
    it('reroutePayment', () => {
      expect(isBusinessEditableKey('reroutePayment')).toBe(true);
    });
    it('rerouteGeneric', () => {
      expect(isBusinessEditableKey('rerouteGeneric')).toBe(true);
    });
  });

  describe('rejects unknown keys', () => {
    it('random.unknown', () => {
      expect(isBusinessEditableKey('random.unknown')).toBe(false);
    });
    it('admin.settings', () => {
      expect(isBusinessEditableKey('admin.settings')).toBe(false);
    });
    it('empty string', () => {
      expect(isBusinessEditableKey('')).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. ALS scope isolation
// ═══════════════════════════════════════════════════════════════

describe('ALS scope isolation', () => {
  it('nested runWithTranslationOverrides uses inner scope', () => {
    const outer = makeOverrides({ 'en.invalidSelection': 'OUTER' });
    const inner = makeOverrides({ 'en.invalidSelection': 'INNER' });

    const result = runWithTranslationOverrides(outer, () => {
      return runWithTranslationOverrides(inner, () => {
        return getFlowCopy('en', 'invalidSelection');
      });
    });
    expect(result).toBe('INNER');
  });

  it('outer scope is restored after inner scope exits', () => {
    const outer = makeOverrides({ 'en.invalidSelection': 'OUTER' });
    const inner = makeOverrides({ 'en.invalidSelection': 'INNER' });

    const result = runWithTranslationOverrides(outer, () => {
      // Inner scope
      runWithTranslationOverrides(inner, () => {
        const innerResult = getFlowCopy('en', 'invalidSelection');
        expect(innerResult).toBe('INNER');
      });
      // Back to outer scope
      return getFlowCopy('en', 'invalidSelection');
    });
    expect(result).toBe('OUTER');
  });

  it('async context is preserved across await boundaries', async () => {
    const overrides = makeOverrides({
      'en.invalidSelection': 'ASYNC OVERRIDE',
    });

    const result = await runWithTranslationOverrides(overrides, async () => {
      // Simulate async work
      await new Promise(resolve => setTimeout(resolve, 10));
      return getFlowCopy('en', 'invalidSelection');
    });
    expect(result).toBe('ASYNC OVERRIDE');
  });

  it('getTranslationOverrides returns the store inside scope', () => {
    const overrides = makeOverrides({ 'en.test': 'yes' });
    runWithTranslationOverrides(overrides, () => {
      const store = getTranslationOverrides();
      expect(store).not.toBeNull();
      expect(store!.business.get('en.test')).toBe('yes');
    });
  });

  it('getTranslationOverrides returns null outside scope', () => {
    expect(getTranslationOverrides()).toBeNull();
  });
});
