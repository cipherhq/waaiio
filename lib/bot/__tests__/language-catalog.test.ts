/**
 * Issue #524 — Slice 1 canonical language catalog contract.
 *
 * The catalog is deliberately dependency-free so it can be imported by both
 * server code and the client dashboard without pulling server-only code into
 * the browser bundle.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CERTIFIED_LANGUAGES,
  CERTIFIED_LANGUAGE_OPTIONS,
  LANGUAGE_CATALOG,
  SUPPORTED_LANGUAGES,
  getLanguageName,
  isSupportedLanguage,
  normalizeLanguageAlias,
} from '../languages';

const EXPECTED_CODES = ['en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es'];

describe('canonical language catalog', () => {
  it('contains exactly the eight architecture-supported languages once each', () => {
    const catalogCodes = LANGUAGE_CATALOG.map(language => language.code);

    expect(catalogCodes).toEqual(EXPECTED_CODES);
    expect(SUPPORTED_LANGUAGES).toEqual(EXPECTED_CODES);
    expect(new Set(catalogCodes).size).toBe(catalogCodes.length);
  });

  it('certifies only English and Nigerian Pidgin after Slice 6 Gate 2', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en', 'pcm']);
    expect(
      LANGUAGE_CATALOG.filter(language => language.certified).map(language => language.code),
    ).toEqual(['en', 'pcm']);
    expect(CERTIFIED_LANGUAGE_OPTIONS).toEqual([
      expect.objectContaining({ code: 'en', displayName: 'English' }),
      expect.objectContaining({ code: 'pcm', displayName: 'Nigerian Pidgin' }),
    ]);
    expect(
      LANGUAGE_CATALOG.filter(language => !language.certified).map(language => language.code),
    ).toEqual(['yo', 'ig', 'ha', 'tw', 'fr', 'es']);
  });

  it('provides non-empty English display names and native names', () => {
    for (const language of LANGUAGE_CATALOG) {
      expect(language.displayName.trim()).not.toBe('');
      expect(language.nativeName.trim()).not.toBe('');
      expect(getLanguageName(language.code)).toBe(language.displayName);
    }

    expect(LANGUAGE_CATALOG.find(language => language.code === 'pcm')).toMatchObject({
      displayName: 'Nigerian Pidgin',
    });
    expect(LANGUAGE_CATALOG.find(language => language.code === 'yo')?.nativeName).toContain('Yor');
    expect(LANGUAGE_CATALOG.find(language => language.code === 'fr')?.nativeName).toBe('Français');
    expect(LANGUAGE_CATALOG.find(language => language.code === 'es')?.nativeName).toBe('Español');
  });

  it.each([
    ['en', 'en'],
    [' English ', 'en'],
    ['PIDGIN', 'pcm'],
    ['Nigerian Pidgin', 'pcm'],
    ['Naija', 'pcm'],
    ['Yorùbá', 'yo'],
    ['Yoruba', 'yo'],
    ['Igbo', 'ig'],
    ['Hausa', 'ha'],
    ['Twi', 'tw'],
    ['Akan', 'tw'],
    ['Français', 'fr'],
    ['Francais', 'fr'],
    ['French', 'fr'],
    ['Español', 'es'],
    ['Espanol', 'es'],
    ['Spanish', 'es'],
  ])('normalizes supported code/name alias %j to %s', (input, expected) => {
    expect(normalizeLanguageAlias(input)).toBe(expected);
  });

  it.each(['', '   ', 'de', 'German', 'klingon', 'en-US', 'English please']) (
    'fails closed for unknown or malformed alias %j',
    input => {
      expect(normalizeLanguageAlias(input)).toBeNull();
      expect(isSupportedLanguage(input)).toBe(false);
    },
  );

  it('recognizes only canonical supported codes as supported languages', () => {
    for (const code of EXPECTED_CODES) {
      expect(isSupportedLanguage(code)).toBe(true);
    }

    // Alias acceptance belongs at the explicit normalization boundary. It must
    // not silently widen code checks used by entitlement and translation.
    expect(isSupportedLanguage('Yorùbá')).toBe(false);
    expect(isSupportedLanguage('EN')).toBe(false);
  });
});

describe('client/server-safe catalog boundary', () => {
  const projectFile = (path: string) =>
    readFileSync(resolve(process.cwd(), path), 'utf8');

  it('has no server-only imports or runtime dependencies', () => {
    const source = projectFile('lib/bot/languages.ts');

    expect(source).not.toMatch(/(?:import|require\s*\()[^\n]*(?:server-only|@anthropic-ai|@supabase|node:)/);
    expect(source).not.toMatch(/@\/lib\/(?:logger|rate-limit|supabase|posthog)/);
    expect(source).not.toMatch(/process\.env/);
  });

  it('is the source consumed by language policy and translation', () => {
    const policy = projectFile('lib/bot/language-policy.ts');
    const translate = projectFile('lib/bot/translate.ts');

    expect(policy).toMatch(/from ['"](?:@\/lib\/bot\/languages|\.\/languages)['"]/);
    expect(translate).toMatch(/from ['"](?:@\/lib\/bot\/languages|\.\/languages)['"]/);

    expect(policy).not.toMatch(
      /export const SUPPORTED_LANGUAGES\s*=\s*\[['"]en['"],\s*['"]pcm['"]/,
    );
    expect(translate).not.toMatch(
      /const SUPPORTED_LANGUAGES\s*:\s*Record<string, string>\s*=\s*{/,
    );
  });

  it('is consumed by the client dashboard instead of a duplicate option list', () => {
    const dashboard = projectFile('app/dashboard/ai-settings/page.tsx');

    expect(dashboard).toMatch(/from ['"]@\/lib\/bot\/languages['"]/);
    expect(dashboard).not.toMatch(/const CERTIFIED_LANGUAGE_OPTIONS\s*=/);
  });
});
