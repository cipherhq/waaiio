/**
 * Slice 561-A — Universal locale corpus governance tests
 *
 * Proves:
 * - Every key in the English baseline exists and is non-empty (T2)
 * - Placeholder integrity across locales (T3)
 * - Bot command preservation across locales (T4)
 * - WhatsApp button title ≤ 20 chars (T7)
 * - WhatsApp list title ≤ 24 chars (T8)
 * - WhatsApp footer ≤ 60 chars (T12)
 * - Certified language uses its locale copy (T5)
 * - Uncertified language falls back to English (T6)
 * - #559 backward compatibility preserved
 * - fillFlowCopy placeholder interpolation
 * - New key registry exported and typed
 */
import { describe, it, expect } from 'vitest';
import {
  getFlowCopy,
  fillFlowCopy,
  getRerouteKey,
  ALL_FLOW_COPY_KEYS,
  PLACEHOLDER_SCHEMA,
  BUTTON_TITLE_KEYS,
  LIST_TITLE_KEYS,
  FOOTER_KEYS,
  KEYS_WITH_COMMANDS,
  _FLOW_COPY_FOR_TESTS,
  PLANNED_LOCALES,
} from '../flows/flow-localization';
import { CERTIFIED_LANGUAGES } from '@/lib/bot/languages';

// ═══════════════════════════════════════════════════════════════
// T2 — English baseline completeness
// ═══════════════════════════════════════════════════════════════

describe('T2: English baseline', () => {
  it('has a non-empty English value for every registered key', () => {
    const en = _FLOW_COPY_FOR_TESTS.en;
    expect(en).toBeDefined();
    for (const key of ALL_FLOW_COPY_KEYS) {
      expect(en[key], `en.${key} missing or empty`).toBeTruthy();
      expect(en[key].length, `en.${key} is empty string`).toBeGreaterThan(0);
    }
  });

  it('contains at least 200 keys (corpus is comprehensive)', () => {
    expect(ALL_FLOW_COPY_KEYS.length).toBeGreaterThanOrEqual(200);
  });
});

// ═══════════════════════════════════════════════════════════════
// T3 — Placeholder integrity
// ═══════════════════════════════════════════════════════════════

describe('T3: placeholder integrity', () => {
  for (const [key, expectedPlaceholders] of PLACEHOLDER_SCHEMA) {
    it(`en.${key} contains all required placeholders`, () => {
      const val = _FLOW_COPY_FOR_TESTS.en[key];
      expect(val).toBeDefined();
      for (const ph of expectedPlaceholders) {
        expect(val, `en.${key} missing {${ph}}`).toContain(`{${ph}}`);
      }
    });

    // Check all populated locales
    for (const lang of Object.keys(_FLOW_COPY_FOR_TESTS)) {
      const val = _FLOW_COPY_FOR_TESTS[lang]?.[key];
      if (!val) continue; // unpopulated locale — fallback covers it
      it(`${lang}.${key} preserves all placeholders`, () => {
        for (const ph of expectedPlaceholders) {
          expect(val, `${lang}.${key} missing {${ph}}`).toContain(`{${ph}}`);
        }
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// T4 — Bot command preservation
// ═══════════════════════════════════════════════════════════════

describe('T4: bot command preservation', () => {
  const BOT_COMMANDS = ['*Hi*', '*cancel*', '*menu*', '*back*', '*exit*', '*skip*'];

  for (const key of KEYS_WITH_COMMANDS) {
    const enVal = _FLOW_COPY_FOR_TESTS.en[key];
    if (!enVal) continue;

    const cmdsInEn = BOT_COMMANDS.filter(c => enVal.includes(c));
    if (cmdsInEn.length === 0) continue;

    for (const lang of Object.keys(_FLOW_COPY_FOR_TESTS)) {
      const val = _FLOW_COPY_FOR_TESTS[lang]?.[key];
      if (!val) continue;
      it(`${lang}.${key} preserves commands [${cmdsInEn.join(', ')}]`, () => {
        for (const cmd of cmdsInEn) {
          expect(val, `${lang}.${key} missing ${cmd}`).toContain(cmd);
        }
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// T7 — WhatsApp button title ≤ 20 chars
// ═══════════════════════════════════════════════════════════════

describe('T7: button titles ≤ 20 chars', () => {
  for (const key of BUTTON_TITLE_KEYS) {
    for (const lang of Object.keys(_FLOW_COPY_FOR_TESTS)) {
      const val = _FLOW_COPY_FOR_TESTS[lang]?.[key];
      if (!val) continue;
      it(`${lang}.${key} (${val.length} chars) ≤ 20`, () => {
        expect(val.length, `${lang}.${key} = "${val}" (${val.length} chars)`).toBeLessThanOrEqual(20);
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// T8 — WhatsApp list title ≤ 24 chars
// ═══════════════════════════════════════════════════════════════

describe('T8: list titles ≤ 24 chars', () => {
  for (const key of LIST_TITLE_KEYS) {
    for (const lang of Object.keys(_FLOW_COPY_FOR_TESTS)) {
      const val = _FLOW_COPY_FOR_TESTS[lang]?.[key];
      if (!val) continue;
      it(`${lang}.${key} (${val.length} chars) ≤ 24`, () => {
        expect(val.length, `${lang}.${key} = "${val}" (${val.length} chars)`).toBeLessThanOrEqual(24);
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// T12 — WhatsApp footer ≤ 60 chars
// ═══════════════════════════════════════════════════════════════

describe('T12: footer ≤ 60 chars', () => {
  for (const key of FOOTER_KEYS) {
    for (const lang of Object.keys(_FLOW_COPY_FOR_TESTS)) {
      const val = _FLOW_COPY_FOR_TESTS[lang]?.[key];
      if (!val) continue;
      it(`${lang}.${key} (${val.length} chars) ≤ 60`, () => {
        expect(val.length, `${lang}.${key} = "${val}" (${val.length} chars)`).toBeLessThanOrEqual(60);
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// T5 — Certified+entitled locale selection
// ═══════════════════════════════════════════════════════════════

describe('T5: certified language uses its locale copy', () => {
  for (const lang of CERTIFIED_LANGUAGES) {
    if (lang === 'en') continue; // English is the baseline, not a "locale override"
    it(`${lang} returns its own copy for keys it has`, () => {
      const langCopy = _FLOW_COPY_FOR_TESTS[lang];
      if (!langCopy) return;
      // Check a few representative keys
      for (const key of ['invalidSelection', 'nav.footer', 'nav.cancelled', 'error.generic']) {
        if (langCopy[key]) {
          expect(getFlowCopy(lang, key)).toBe(langCopy[key]);
        }
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// T6 — Uncertified language falls back to English
// ═══════════════════════════════════════════════════════════════

describe('T6: uncertified language falls back to English', () => {
  const uncertified = PLANNED_LOCALES.filter(l => !CERTIFIED_LANGUAGES.includes(l));
  for (const lang of uncertified) {
    it(`${lang} falls back to English`, () => {
      // Even if FLOW_COPY has entries for this lang, getFlowCopy should return English
      expect(getFlowCopy(lang, 'nav.footer')).toBe(_FLOW_COPY_FOR_TESTS.en['nav.footer']);
      expect(getFlowCopy(lang, 'error.generic')).toBe(_FLOW_COPY_FOR_TESTS.en['error.generic']);
    });
  }

  it('undefined language falls back to English', () => {
    expect(getFlowCopy(undefined, 'nav.footer')).toBe(_FLOW_COPY_FOR_TESTS.en['nav.footer']);
  });

  it('unknown language code falls back to English', () => {
    expect(getFlowCopy('xx', 'nav.footer')).toBe(_FLOW_COPY_FOR_TESTS.en['nav.footer']);
  });
});

// ═══════════════════════════════════════════════════════════════
// #559 backward compatibility
// ═══════════════════════════════════════════════════════════════

describe('#559 backward compatibility', () => {
  it('preserves all original #559 keys', () => {
    const legacyKeys = [
      'invalidSelection', 'cancelHint',
      'rerouteBooking', 'rerouteOrdering', 'rerouteTicketing',
      'reroutePayment', 'rerouteGeneric',
      'yes', 'stayHere',
    ];
    for (const key of legacyKeys) {
      expect(_FLOW_COPY_FOR_TESTS.en[key], `en.${key} missing`).toBeTruthy();
      expect(_FLOW_COPY_FOR_TESTS.pcm[key], `pcm.${key} missing`).toBeTruthy();
    }
  });

  it('returns Pidgin copy when pcm is certified and effective', () => {
    expect(getFlowCopy('pcm', 'invalidSelection')).toBe('That option no dey. Tap one of the choices wey dey above.');
    expect(getFlowCopy('pcm', 'cancelHint')).toContain('comot');
    expect(getFlowCopy('pcm', 'rerouteBooking')).toContain('book something');
  });

  it('returns English copy for English', () => {
    expect(getFlowCopy('en', 'invalidSelection')).toBe('That option is not available. Tap one of the choices above.');
    expect(getFlowCopy('en', 'cancelHint')).toContain('exit');
  });

  it('getRerouteKey maps intents to prompt keys', () => {
    expect(getRerouteKey('booking')).toBe('rerouteBooking');
    expect(getRerouteKey('ordering')).toBe('rerouteOrdering');
    expect(getRerouteKey('ticketing')).toBe('rerouteTicketing');
    expect(getRerouteKey('payment')).toBe('reroutePayment');
    expect(getRerouteKey(null)).toBe('rerouteGeneric');
  });
});

// ═══════════════════════════════════════════════════════════════
// fillFlowCopy interpolation
// ═══════════════════════════════════════════════════════════════

describe('fillFlowCopy', () => {
  it('interpolates placeholders in English', () => {
    const result = fillFlowCopy('en', 'nav.exit_what_next', { businessName: 'Bukka Hut' });
    expect(result).toBe("You've left Bukka Hut. What next?");
  });

  it('interpolates placeholders in Pidgin', () => {
    const result = fillFlowCopy('pcm', 'nav.exit_what_next', { businessName: 'Bukka Hut' });
    expect(result).toBe('You don comot from Bukka Hut. Wetin you wan do?');
  });

  it('interpolates language name placeholder', () => {
    const result = fillFlowCopy('en', 'lang.switched', { langName: 'Pidgin' });
    expect(result).toBe('Switched to Pidgin. ✅');
  });

  it('falls back to English for uncertified locale', () => {
    const result = fillFlowCopy('fr', 'nav.exit_what_next', { businessName: 'Le Café' });
    expect(result).toBe("You've left Le Café. What next?");
  });

  it('handles unknown key gracefully', () => {
    const result = fillFlowCopy('en', 'nonexistent.key', {});
    expect(result).toBe('nonexistent.key');
  });
});

// ═══════════════════════════════════════════════════════════════
// Key registry metadata
// ═══════════════════════════════════════════════════════════════

describe('key registry metadata', () => {
  it('BUTTON_TITLE_KEYS are all valid keys', () => {
    for (const key of BUTTON_TITLE_KEYS) {
      expect(_FLOW_COPY_FOR_TESTS.en[key], `button key ${key} not in en`).toBeTruthy();
    }
  });

  it('LIST_TITLE_KEYS are all valid keys', () => {
    for (const key of LIST_TITLE_KEYS) {
      expect(_FLOW_COPY_FOR_TESTS.en[key], `list key ${key} not in en`).toBeTruthy();
    }
  });

  it('FOOTER_KEYS are all valid keys', () => {
    for (const key of FOOTER_KEYS) {
      expect(_FLOW_COPY_FOR_TESTS.en[key], `footer key ${key} not in en`).toBeTruthy();
    }
  });

  it('KEYS_WITH_COMMANDS are all valid keys', () => {
    for (const key of KEYS_WITH_COMMANDS) {
      expect(_FLOW_COPY_FOR_TESTS.en[key], `command key ${key} not in en`).toBeTruthy();
    }
  });

  it('PLACEHOLDER_SCHEMA keys are all valid keys', () => {
    for (const [key] of PLACEHOLDER_SCHEMA) {
      expect(_FLOW_COPY_FOR_TESTS.en[key], `placeholder key ${key} not in en`).toBeTruthy();
    }
  });

  it('PLANNED_LOCALES includes all 8 languages', () => {
    expect(PLANNED_LOCALES).toContain('en');
    expect(PLANNED_LOCALES).toContain('pcm');
    expect(PLANNED_LOCALES).toContain('yo');
    expect(PLANNED_LOCALES).toContain('ig');
    expect(PLANNED_LOCALES).toContain('ha');
    expect(PLANNED_LOCALES).toContain('tw');
    expect(PLANNED_LOCALES).toContain('fr');
    expect(PLANNED_LOCALES).toContain('es');
  });
});

// ═══════════════════════════════════════════════════════════════
// T1 — Key completeness for populated locales
// ═══════════════════════════════════════════════════════════════

describe('T1: key completeness for populated locales', () => {
  for (const lang of Object.keys(_FLOW_COPY_FOR_TESTS)) {
    it(`${lang} has all keys from English baseline`, () => {
      const langCopy = _FLOW_COPY_FOR_TESTS[lang];
      const missing: string[] = [];
      for (const key of ALL_FLOW_COPY_KEYS) {
        if (!langCopy[key]) missing.push(key);
      }
      expect(missing, `${lang} missing ${missing.length} keys: ${missing.slice(0, 5).join(', ')}...`).toHaveLength(0);
    });
  }
});
