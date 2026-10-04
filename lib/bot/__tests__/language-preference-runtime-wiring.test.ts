import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const botServiceSource = fs.readFileSync(
  path.join(process.cwd(), 'lib/bot/bot.service.ts'),
  'utf8',
);

describe('#524 Slice 1 runtime language-preference wiring', () => {
  it('loads a remembered preference only after authoritative business routing is bound', () => {
    const authorityBoundary = botServiceSource.indexOf('Bind resolved business to sender for hard-stop guard');
    const preferenceRead = botServiceSource.indexOf('readPreferredResponseLanguage');

    expect(authorityBoundary).toBeGreaterThan(-1);
    expect(preferenceRead).toBeGreaterThan(authorityBoundary);
  });

  it('keeps a remembered preference presentation-only: offer once, never business authority', () => {
    expect(botServiceSource).toContain('_pending_language_source');
    expect(botServiceSource).toContain("_pending_language_source: 'remembered'");
    expect(botServiceSource).toContain('_remembered_language_offered');

    const preferenceRead = botServiceSource.indexOf('readPreferredResponseLanguage');
    const sessionCreation = botServiceSource.indexOf(".from('bot_sessions')", preferenceRead);
    const authorityBoundary = botServiceSource.indexOf('Bind resolved business to sender for hard-stop guard');

    expect(preferenceRead).toBeGreaterThan(authorityBoundary);
    expect(sessionCreation).toBeGreaterThan(preferenceRead);
  });

  it('revalidates remembered preferences through the existing entitlement and certification boundaries', () => {
    const preferenceRead = botServiceSource.indexOf('readPreferredResponseLanguage');
    const followingRuntime = botServiceSource.slice(preferenceRead, preferenceRead + 6_000);

    expect(followingRuntime).toMatch(/(?:buildTranslationContext|getEffectiveLanguages)/);
    expect(followingRuntime).toContain('CERTIFIED_LANGUAGES');
    expect(followingRuntime).toContain('resolveEffectiveResponseLanguage');
  });

  it('does not use preferred response language as a business lookup predicate', () => {
    expect(botServiceSource).not.toMatch(
      /(?:businesses|business_id)[\s\S]{0,120}(?:preferred_response_language)[\s\S]{0,120}(?:eq|match|filter)\s*\(/,
    );
  });
});
