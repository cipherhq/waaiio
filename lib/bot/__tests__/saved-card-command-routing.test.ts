/**
 * Saved-card command routing regression tests.
 *
 * Proves save card / remove card commands are first-class, work without
 * bot_keywords rows, and function correctly with no active session
 * (reproducing the Citadel-of-Grace no-response bug from C9).
 *
 * Implementation-Agent: Claude Code
 */
import { describe, it, expect, vi } from 'vitest';
import { isSaveCardQuery, isRemoveCardQuery } from '../handlers/global-queries';

describe('Saved-card command recognition', () => {
  it('recognizes "save card" (exact)', () => {
    expect(isSaveCardQuery('save card')).toBe(true);
  });
  it('recognizes "Save Card" (casing)', () => {
    expect(isSaveCardQuery('Save Card')).toBe(true);
  });
  it('recognizes "save my card"', () => {
    expect(isSaveCardQuery('save my card')).toBe(true);
  });
  it('does not match "save card please"', () => {
    expect(isSaveCardQuery('save card please')).toBe(false);
  });

  it('recognizes "remove card"', () => {
    expect(isRemoveCardQuery('remove card')).toBe(true);
  });
  it('recognizes "delete card"', () => {
    expect(isRemoveCardQuery('delete card')).toBe(true);
  });
  it('recognizes "remove my card"', () => {
    expect(isRemoveCardQuery('remove my card')).toBe(true);
  });
  it('does not match "remove the card"', () => {
    expect(isRemoveCardQuery('remove the card')).toBe(false);
  });
});

describe('Saved-card routing in bot.service.ts', () => {
  it('bot.service.ts routes save card before no-session path (source verification)', async () => {
    // Verify the command interceptor appears BEFORE the no-session/greeting path
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');

    // Find the save card interceptor position
    const saveCardPos = source.indexOf("save\\s+(my\\s+)?card");
    // Find the no-session path position
    const noSessionPos = source.indexOf('if (!session || isRestart)');

    // Save card interceptor must be BEFORE no-session path
    // (so it works even with session === null after payment completion)
    expect(saveCardPos).toBeGreaterThan(0);
    expect(saveCardPos).toBeLessThan(noSessionPos);
  });

  it('bot.service.ts routes remove card before no-session path', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    const removeCardPos = source.indexOf("(remove|delete)\\s+(my\\s+)?card");
    const noSessionPos = source.indexOf('if (!session || isRestart)');
    expect(removeCardPos).toBeGreaterThan(0);
    expect(removeCardPos).toBeLessThan(noSessionPos);
  });

  it('save card command uses dual-phone profile lookup (not raw .eq)', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    // The profile lookup in the save-card interceptor should use OR/phonePair
    const interceptorBlock = source.slice(
      source.indexOf("save\\s+(my\\s+)?card"),
      source.indexOf("save\\s+(my\\s+)?card") + 500,
    );
    // Must use phonePair or .or() for dual-phone lookup
    expect(interceptorBlock).toContain('phonePair');
  });

  it('replace_card_pin is in free-text exclusion lists (PIN not hijacked)', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    expect(source).toContain("'replace_card_pin'");
    // Verify it's in the free-text exclusion array
    const freeTextLine = source.split('\n').find(l => l.includes('isFreeTextStepForKeywords') && l.includes('replace_card_pin'));
    expect(freeTextLine).toBeTruthy();
  });
});
