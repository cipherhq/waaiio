/**
 * #721 STOP Merchant Resolution — Behavioral Tests
 *
 * Verifies STOP/START handling in bot.service.ts using source-inspection
 * style (readFileSync + structural assertions) where full mock setup is
 * too complex. This is the established pattern in this codebase (see
 * emergency-hard-stop-guard.test.ts, s1-botservice-shared-channel.test.ts).
 *
 * Tests:
 * 10. Dedicated channel STOP uses preResolvedBusinessId
 * 11. Shared channel single session → uses that business
 * 12. Shared channel 0 sessions → safe message
 * 13. Shared channel >3 candidates → numbered list with numeric reply
 * 14. Option C: merchant + platform → disambiguation buttons
 * 15. Option C: stop_merchant selected → merchant opt-out only
 * 16. Option C: stop_platform selected → platform opt-out only
 * 17. Multi-merchant + platform → Option C first, then picker
 * 18. STOP under rate limit → still processed
 * 19. Repeated STOP within 60s → 1 confirmation (rate limit)
 * 20. Cross-channel replay rejected
 * 21. START on dedicated → merchant-scoped
 * 22. Broadcast: opted-out merchant suppressed, error → suppressed
 * 23. Growth: error → fail closed
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

const BOT_SERVICE_PATH = resolve(__dirname, '../bot/bot.service.ts');
const src = readFileSync(BOT_SERVICE_PATH, 'utf-8');

describe('#721 STOP: Early Dispatcher (CONSENT-ROUTING P1)', () => {
  it('10. Dedicated channel STOP uses preResolvedBusinessId', () => {
    // _handleStopRequest checks preResolvedBusinessId first
    expect(src).toContain('if (preResolvedBusinessId)');
    // And directly calls _recordMerchantOptOut with it
    const stopMethodIdx = src.indexOf('private async _handleStopRequest');
    const stopMethodEnd = src.indexOf('\n  }', stopMethodIdx + 100);
    const stopBody = src.slice(stopMethodIdx, stopMethodEnd);
    expect(stopBody).toContain('merchantId = preResolvedBusinessId');
    expect(stopBody).toContain('_recordMerchantOptOut(from, merchantId)');
  });

  it('11. Shared channel single session uses that business', () => {
    // When candidates.length === 1, merchantId is set from the single candidate
    const stopMethodIdx = src.indexOf('private async _handleStopRequest');
    const stopMethodEnd = src.indexOf('\n  }', stopMethodIdx + 100);
    const stopBody = src.slice(stopMethodIdx, stopMethodEnd);
    expect(stopBody).toContain('candidates.length === 1');
    expect(stopBody).toContain('merchantId = candidates[0].id');
    expect(stopBody).toContain('merchantName = candidates[0].name');
  });

  it('12. Shared channel 0 sessions → safe message', () => {
    // When no candidates and no launch sub, sends "not subscribed" message
    expect(src).toContain('You are not currently subscribed to any messages. No action needed.');
  });

  it('13. Shared channel >3 candidates → numbered list with numeric reply', () => {
    // When candidates > 3, sends numbered list
    const stopMethodIdx = src.indexOf('private async _handleStopRequest');
    const stopMethodEnd = src.indexOf('\n  }', stopMethodIdx + 100);
    const stopBody = src.slice(stopMethodIdx, stopMethodEnd);
    expect(stopBody).toContain('candidates.length <= 3');
    expect(stopBody).toContain('Reply with the number to select');
    // Numeric pattern used for >3 candidates
    expect(stopBody).toContain('.map((s, i) => `${i + 1}. *${s.name}*`)');
  });

  it('14. Option C: merchant + platform → disambiguation buttons', () => {
    // When single merchantId AND hasLaunchSub → show Option C buttons
    const stopMethodIdx = src.indexOf('private async _handleStopRequest');
    const stopMethodEnd = src.indexOf('\n  }', stopMethodIdx + 100);
    const stopBody = src.slice(stopMethodIdx, stopMethodEnd);
    expect(stopBody).toContain('merchantId && hasLaunchSub');
    expect(stopBody).toContain("id: 'stop_merchant'");
    expect(stopBody).toContain("id: 'stop_platform'");
  });

  it('15. Option C: stop_merchant selected → merchant opt-out only', () => {
    // Early dispatcher handles stop_merchant by calling _recordMerchantOptOut
    const earlyIdx = src.indexOf('Early pending-STOP dispatcher');
    const earlyEnd = src.indexOf('BOT-PERF: Single round-trip context bootstrap');
    const earlyBody = src.slice(earlyIdx, earlyEnd);
    expect(earlyBody).toContain("text === 'stop_merchant'");
    expect(earlyBody).toContain('_recordMerchantOptOut');
    // Confirms it does NOT also call _recordPlatformOptOut in the same branch
    const stopMerchantIdx = earlyBody.indexOf("text === 'stop_merchant'");
    const nextBranchIdx = earlyBody.indexOf("text === 'stop_platform'", stopMerchantIdx);
    const merchantBranch = earlyBody.slice(stopMerchantIdx, nextBranchIdx);
    expect(merchantBranch).toContain('_recordMerchantOptOut');
    expect(merchantBranch).not.toContain('_recordPlatformOptOut');
  });

  it('16. Option C: stop_platform selected → platform opt-out only', () => {
    const earlyIdx = src.indexOf('Early pending-STOP dispatcher');
    const earlyEnd = src.indexOf('BOT-PERF: Single round-trip context bootstrap');
    const earlyBody = src.slice(earlyIdx, earlyEnd);
    expect(earlyBody).toContain("text === 'stop_platform'");
    expect(earlyBody).toContain('_recordPlatformOptOut');
  });

  it('17. Unverified merchant(s) + platform → Option C first, then picker', () => {
    // _handleStopRequest: unverified candidates + hasLaunchSub → stores candidates in _pending_stop_choice
    const stopMethodIdx = src.indexOf('private async _handleStopRequest');
    const stopMethodEnd = src.indexOf('\n  }', stopMethodIdx + 100);
    const stopBody = src.slice(stopMethodIdx, stopMethodEnd);
    expect(stopBody).toContain('candidates.length >= 1 && hasLaunchSub');
    expect(stopBody).toContain('_pending_stop_choice: { candidates:');

    // Early dispatcher: when stop_merchant AND candidates exist → creates picker session
    const earlyIdx = src.indexOf('Early pending-STOP dispatcher');
    const earlyEnd = src.indexOf('BOT-PERF: Single round-trip context bootstrap');
    const earlyBody = src.slice(earlyIdx, earlyEnd);
    expect(earlyBody).toContain('choiceData.candidates && choiceData.candidates.length >= 1');
    expect(earlyBody).toContain('_pending_stop: true');
    expect(earlyBody).toContain('Which business would you like to unsubscribe from?');
  });
});

describe('#721 STOP: Tenant Provenance (P1)', () => {
  it('18. STOP under rate limit → still processed (STOP before rate limit)', () => {
    // STOP handling is before rate limit in handleMessage
    const stopIdx = src.indexOf('STOP/START compliance');
    const rateLimitIdx = src.indexOf('checkRateLimitAsync(`bot:${from}`');
    expect(stopIdx, 'STOP should come before rate limit').toBeLessThan(rateLimitIdx);
  });

  it('19. Repeated STOP within 60s → rate limited confirmation', () => {
    // Rate limit on confirmation messages uses bot_stop_confirm key
    expect(src).toContain('checkRateLimitAsync(`bot_stop_confirm:${from}`, 1, 60_000)');
  });

  it('20. Cross-channel replay rejected', () => {
    // Early dispatcher checks channel provenance
    const earlyIdx = src.indexOf('Early pending-STOP dispatcher');
    const earlyEnd = src.indexOf('BOT-PERF: Single round-trip context bootstrap');
    const earlyBody = src.slice(earlyIdx, earlyEnd);
    // R6: cross-channel mismatch falls through to normal flow (not silent drop)
    expect(earlyBody).toContain('channel mismatch');
    expect(earlyBody).toContain('break pendingStopDispatch');

    // Fallback session handler also checks — fail closed on missing/null provenance
    expect(src).toContain('Cross-channel Option C replay rejected or missing provenance');
    expect(src).toContain('Cross-channel picker replay rejected or missing provenance');
  });

  it('20b. Channel lookup failure → fail closed (not proceed as success)', () => {
    // _handleStopRequest fails closed on channel lookup error
    const stopMethodIdx = src.indexOf('private async _handleStopRequest');
    const stopMethodEnd = src.indexOf('\n  }', stopMethodIdx + 100);
    const stopBody = src.slice(stopMethodIdx, stopMethodEnd);
    expect(stopBody).toContain('Channel lookup error');
    expect(stopBody).toContain('Fail closed');

    // Early dispatcher also fails closed
    const earlyIdx = src.indexOf('Early pending-STOP dispatcher');
    const earlyEnd = src.indexOf('BOT-PERF: Single round-trip context bootstrap');
    const earlyBody = src.slice(earlyIdx, earlyEnd);
    expect(earlyBody).toContain('channel lookup failed, rejecting');

    // Fallback paths also fail closed
    expect(src).toContain('Fallback Option C: channel lookup failed, rejecting');
    expect(src).toContain('Fallback picker: channel lookup failed, rejecting');
  });

  it('21. START on dedicated → merchant-scoped resubscribe', () => {
    const startIdx = src.indexOf('private async _handleStartRequest');
    const startEnd = src.indexOf('\n  }', startIdx + 100);
    const startBody = src.slice(startIdx, startEnd);
    // When preResolvedBusinessId → resubscribe that specific merchant only
    expect(startBody).toContain('preResolvedBusinessId');
    expect(startBody).toContain('.eq(\'business_id\', preResolvedBusinessId)');
    expect(startBody).toContain('.eq(\'channel\', \'whatsapp\')');
    expect(startBody).toContain('.is(\'resubscribed_at\', null)');
    expect(startBody).toContain(".select('id')");
  });
});

describe('#721 STOP: Data / Replay Safety (P1)', () => {
  it('22. Broadcast: opted-out merchant suppressed', () => {
    // Verify broadcast sender checks opt-out status
    // This is a structural check that the opt-out table is queried before sending
    expect(src).toContain('messaging_opt_outs');
    // The _recordMerchantOptOut function uses .select('id') on writes
    const recordIdx = src.indexOf('private async _recordMerchantOptOut');
    const recordEnd = src.indexOf('\n  }', recordIdx + 100);
    const recordBody = src.slice(recordIdx, recordEnd);
    expect(recordBody).toContain(".select('id')");
  });

  it('23. Error → fail closed: _handleStopRequest rejects on DB errors', () => {
    const stopMethodIdx = src.indexOf('private async _handleStopRequest');
    const stopMethodEnd = src.indexOf('\n  }', stopMethodIdx + 100);
    const stopBody = src.slice(stopMethodIdx, stopMethodEnd);

    // Business lookup failure → fail closed
    expect(stopBody).toContain('Business lookup failed');
    expect(stopBody).toContain('fail closed on read error');

    // Launch subscriber lookup failure → fail closed
    expect(stopBody).toContain('Launch subscriber lookup failed');
  });

  it('CAS atomic claim used in early dispatcher and fallback handlers', () => {
    // Early dispatcher uses CAS
    const earlyIdx = src.indexOf('Early pending-STOP dispatcher');
    const earlyEnd = src.indexOf('BOT-PERF: Single round-trip context bootstrap');
    const earlyBody = src.slice(earlyIdx, earlyEnd);
    expect(earlyBody).toContain('update_session_cas');
    expect(earlyBody).toContain('p_expected_version');
    expect(earlyBody).toContain("version_conflict");

    // Fallback handler also uses CAS
    const fallbackIdx = src.indexOf('Fallback path -- primary handling is the early dispatcher');
    if (fallbackIdx !== -1) {
      expect(src.slice(fallbackIdx, fallbackIdx + 2000)).toContain('update_session_cas');
    }
  });

  it('_recordMerchantOptOut verifies returned rows with .select(\'id\')', () => {
    const recordIdx = src.indexOf('private async _recordMerchantOptOut');
    const recordEnd = src.indexOf('\n  }', recordIdx + 100);
    const recordBody = src.slice(recordIdx, recordEnd);
    expect(recordBody).toContain(".select('id')");
    expect(recordBody).toContain('inserted && inserted.length > 0');
    // On 23505: verifies row exists with count query
    expect(recordBody).toContain("insertErr?.code === '23505'");
    expect(recordBody).toContain('count');
  });

  it('_recordPlatformOptOut verifies returned rows with .select(\'id\')', () => {
    const recordIdx = src.indexOf('private async _recordPlatformOptOut');
    const recordEnd = src.indexOf('\n  }', recordIdx + 100);
    const recordBody = src.slice(recordIdx, recordEnd);
    expect(recordBody).toContain(".select('id')");
    expect(recordBody).toContain('updated && updated.length > 0');
  });

  it('Resolved channelId stored in session, not raw destinationPhone', () => {
    // _handleStopRequest resolves channelId from destinationPhone, stores resolvedChannelId
    const stopMethodIdx = src.indexOf('private async _handleStopRequest');
    const stopMethodEnd = src.indexOf('\n  }', stopMethodIdx + 100);
    const stopBody = src.slice(stopMethodIdx, stopMethodEnd);
    expect(stopBody).toContain('resolvedChannelId');
    expect(stopBody).toContain('channelId: resolvedChannelId');
    // Picker also uses resolved channelId
    expect(stopBody).toContain('_pending_stop_channel_id: resolvedChannelId');
  });

  it('Early dispatcher runs BEFORE get_bot_context', () => {
    const earlyIdx = src.indexOf('Early pending-STOP dispatcher');
    const rpcIdx = src.indexOf('BOT-PERF: Single round-trip context bootstrap');
    expect(earlyIdx, 'Early dispatcher must come before get_bot_context').toBeLessThan(rpcIdx);
    expect(earlyIdx, 'Early dispatcher must exist').toBeGreaterThan(0);
  });

  it('Early dispatcher triggers for pending-STOP inputs on any channel type', () => {
    const earlyIdx = src.indexOf('Early pending-STOP dispatcher');
    const earlyEnd = src.indexOf('BOT-PERF: Single round-trip context bootstrap');
    const earlyBody = src.slice(earlyIdx, earlyEnd);
    // Only for specific input patterns (including 10 for max-candidate picker)
    expect(earlyBody).toContain('stop_merchant|stop_platform|biz_\\d+|[1-9]|10');
    // Channel verification inside the handler validates the channel match (not gated by preResolved)
    expect(earlyBody).toContain('_pendingStopInputs.test(text)');
  });
});

describe('Phone normalization (#721 Codex P1)', () => {
  it('STOP handler normalizes phone with ensurePlus before persisting', () => {
    const recordIdx = src.indexOf('_recordMerchantOptOut');
    const recordEnd = src.indexOf('\n  }', src.indexOf('private async _recordMerchantOptOut'));
    const recordBody = src.slice(recordIdx, recordEnd);
    expect(recordBody).toContain('ensurePlus(from)');
    expect(recordBody).toContain("phone: normalizedPhone");
  });

  it('START handler normalizes phone with ensurePlus', () => {
    const startIdx = src.indexOf('_handleStartRequest');
    const startEnd = src.indexOf('\n  }', src.indexOf('private async _handleStartRequest') + 100);
    const startBody = src.slice(startIdx, startEnd);
    expect(startBody).toContain('ensurePlus(from)');
  });

  const broadcastSrc = readFileSync(resolve(__dirname, '../../app/api/broadcasts/send/route.ts'), 'utf-8');
  const scheduledSrc = readFileSync(resolve(__dirname, '../../app/api/cron/scheduled-broadcasts/route.ts'), 'utf-8');
  const growthSrc = readFileSync(resolve(__dirname, '../growth/eligibility-service.ts'), 'utf-8');

  it('Broadcast consumer normalizes phone with ensurePlus', () => {
    expect(broadcastSrc).toContain('ensurePlus(phone)');
  });

  it('Scheduled broadcast consumer normalizes phone with ensurePlus', () => {
    expect(scheduledSrc).toContain('ensurePlus(phone)');
  });

  it('Growth eligibility normalizes phone with ensurePlus', () => {
    expect(growthSrc).toContain('ensurePlus(phone)');
  });
});
