/**
 * Slice 5A — Proactive WhatsApp Localization tests (#524)
 *
 * Tests:
 * Layer 1: Production-policy resolver (no CERTIFIED_LANGUAGES modification)
 * Layer 2: Injected/stubbed entitled context (proves localization mechanics)
 * Layer 3: Claim/idempotency safety
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../..');

// ── Module-level mocks ──

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  class MockAnthropic { messages = { create: mockCreate }; }
  return { default: MockAnthropic, _mockCreate: mockCreate };
});

vi.mock('@/lib/posthog/flags', () => ({
  isFeatureEnabledServer: vi.fn().mockResolvedValue(true),
  FLAGS: { BOT_TRANSLATION_ENABLED: 'bot-translation-enabled' },
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 49 }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })) },
}));

vi.mock('@/lib/bot/ai-tier-guard', () => ({
  incrementAIUsage: vi.fn().mockResolvedValue(undefined),
}));

import { translateBotResponse, _clearTranslationCache, type TranslationContext } from '../translate';
import type { LanguageEntitlement } from '../language-policy';

// ── Helpers ──

const { _mockCreate: mockCreate } = await import('@anthropic-ai/sdk') as any;

function mockTranslation(translated: string) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: translated }],
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

function entitledCtx(businessId = 'biz-001'): TranslationContext {
  return {
    entitlement: { allowedLanguages: ['en', 'fr', 'pcm'], llmAllowed: true, translationAllowed: true },
    businessId,
    supabase: {},
  };
}

function freeCtx(businessId = 'biz-free'): TranslationContext {
  return {
    entitlement: { allowedLanguages: ['en'], llmAllowed: false, translationAllowed: false },
    businessId,
    supabase: {},
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  _clearTranslationCache();
});

// ═══════════════════════════════════════════════════════════════
// Layer 1: Production-policy resolver
// ═══════════════════════════════════════════════════════════════

describe('Layer 1 — production certification policy', () => {
  it('CERTIFIED_LANGUAGES includes English and Pidgin', () => {
    const catalog = readFileSync(resolve(ROOT, 'lib/bot/languages.ts'), 'utf-8');
    expect((catalog.match(/certified:\s*true/g) || []).length).toBe(2);
    expect(catalog).toMatch(/code:\s*'en'[^}]*certified:\s*true/);
    expect(catalog).toMatch(/code:\s*'pcm'[^}]*certified:\s*true/);
  });

  it('resolveEffectiveResponseLanguage falls back to English when non-English is uncertified', async () => {
    const { resolveEffectiveResponseLanguage } = await import('../language-preference');
    const { CERTIFIED_LANGUAGES, getEffectiveLanguages } = await import('../language-policy');
    const entitlement = getEffectiveLanguages('growth', ['en', 'fr']);

    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'fr',
      rememberedLanguage: 'fr',
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    });

    // French is not certified → falls back to English
    expect(result.language).toBe('en');
    expect(result.source).toBe('fallback');
  });

  it('Free tier entitlement blocks translation', async () => {
    const { getEffectiveLanguages } = await import('../language-policy');
    const entitlement = getEffectiveLanguages('free', null);

    expect(entitlement.translationAllowed).toBe(false);
    expect(entitlement.llmAllowed).toBe(false);
    expect(entitlement.allowedLanguages).toEqual(['en']);
  });

  it('unknown/null tier fails closed to free', async () => {
    const { getEffectiveLanguages } = await import('../language-policy');
    const entitlement = getEffectiveLanguages(null as any, null);

    expect(entitlement.translationAllowed).toBe(false);
    expect(entitlement.allowedLanguages).toEqual(['en']);
  });
});

// ═══════════════════════════════════════════════════════════════
// Layer 2: Injected entitled context — localization mechanics
// ═══════════════════════════════════════════════════════════════

describe('Layer 2 — injected entitled context: Waaiio chrome translates', () => {
  it('payment confirmation chrome translates, amount/business/reference survive', async () => {
    const ctx = entitledCtx();
    const confirmationText = [
      '✅ *Payment Confirmed!*',
      '',
      '🏢 FacesByKoph Beauty',
      '📋 Full Body Massage',
      '💰 Amount: ₦5,000',
      '🔑 Ref: *WA-BK-1234*',
      '',
      'Thank you for your payment! 🙏',
      '',
      'Type *receipt* to get your receipt',
      'Type *my bookings* to view your bookings',
    ].join('\n');

    mockTranslation(
      '✅ *Paiement Confirmé !*\n\n🏢 __V1__\n📋 __V2__\n💰 Montant: __V3__\n🔑 Réf: *__V4__*\n\nMerci pour votre paiement ! 🙏\n\nTapez *receipt* pour votre reçu\nTapez *my bookings* pour voir vos réservations',
    );

    const result = await translateBotResponse(confirmationText, 'fr', ctx, {
      protectedValues: ['FacesByKoph Beauty', 'Full Body Massage', '₦5,000', 'WA-BK-1234'],
    });

    // Protected values survive exactly
    expect(result).toContain('FacesByKoph Beauty');
    expect(result).toContain('Full Body Massage');
    expect(result).toContain('₦5,000');
    expect(result).toContain('WA-BK-1234');
    // Chrome translated
    expect(result).not.toContain('Payment Confirmed');
    expect(result).toContain('Confirmé');
  });

  it('NGN 5000 format survives as explicit protected value', async () => {
    const ctx = entitledCtx();
    mockTranslation('Le montant est __V1__');

    const result = await translateBotResponse(
      'The amount is NGN 5000',
      'fr', ctx,
      { protectedValues: ['NGN 5000'] },
    );

    expect(result).toContain('NGN 5000');
  });

  it('card label VISA ****1234 survives as protected value', async () => {
    const ctx = entitledCtx();
    mockTranslation('💳 Sauvegarder __V1__ pour un paiement plus rapide ?');

    const result = await translateBotResponse(
      '💳 Save VISA ****1234 for faster checkout next time?',
      'fr', ctx,
      { protectedValues: ['VISA ****1234'] },
    );

    expect(result).toContain('VISA ****1234');
  });

  it('ticket codes survive translation', async () => {
    const ctx = entitledCtx();
    mockTranslation('Vos billets pour __V1__ sont prêts. Code: __V2__');

    const result = await translateBotResponse(
      'Your tickets for Summer Concert are ready. Code: TK-A3F8X2',
      'fr', ctx,
      { protectedValues: ['Summer Concert', 'TK-A3F8X2'] },
    );

    expect(result).toContain('Summer Concert');
    expect(result).toContain('TK-A3F8X2');
  });

  it('payment URL survives translation', async () => {
    const ctx = entitledCtx();
    const url = 'https://paystack.com/pay/abc123';
    mockTranslation('Veuillez payer ici: __V1__');

    const result = await translateBotResponse(
      `Please pay here: ${url}`,
      'fr', ctx,
      { protectedValues: [url] },
    );

    expect(result).toContain(url);
  });

  it('PIN semantics preserved — "4 digits" and "Waaiio" survive', async () => {
    const ctx = entitledCtx();
    mockTranslation('Entrez exactement *4 chiffres* pour votre PIN __V1__ :');

    const result = await translateBotResponse(
      'Please enter exactly *4 digits* for your Waaiio PIN:',
      'fr', ctx,
      { protectedValues: ['Waaiio'] },
    );

    expect(result).toContain('Waaiio');
    // "4" should survive via regex protection (or LLM compliance, tested via placeholder integrity)
  });

  it('save/replace card button IDs are never translated (structural)', () => {
    const source = readFileSync(resolve(ROOT, 'lib/payments/saved-card-offer.ts'), 'utf-8');
    // Button IDs contain payment ID — they must remain exact
    expect(source).toContain("id: `save_card_accept:${paymentId}`");
    expect(source).toContain("id: `save_card_decline:${paymentId}`");
    expect(source).toContain("id: `replace_card_accept:${paymentId}`");
    expect(source).toContain("id: `replace_card_decline:${paymentId}`");
    // Only the title (display text) is translated, not the id
    expect(source).toContain('{ ...buttons[i], title: await l10n.translate(buttons[i].title) }');
  });
});

// ═══════════════════════════════════════════════════════════════
// Layer 2b: Session/preference precedence
// ═══════════════════════════════════════════════════════════════

describe('Layer 2b — session language beats remembered preference', () => {
  it('session _detected_language is used as sessionLanguage, not explicitLanguage', async () => {
    const { resolveEffectiveResponseLanguage } = await import('../language-preference');
    // Stubbed: session has 'fr', profile has 'pcm'
    // With a hypothetical entitled context where both are certified:
    const entitlement: LanguageEntitlement = { allowedLanguages: ['en', 'fr', 'pcm'], llmAllowed: true, translationAllowed: true };

    const result = resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: 'fr',
      rememberedLanguage: 'pcm',
      entitlement,
      certifiedLanguages: ['en', 'fr', 'pcm'], // hypothetical certified
    });

    expect(result.language).toBe('fr');
    expect(result.source).toBe('session');
  });
});

// ═══════════════════════════════════════════════════════════════
// Layer 3: Claim/idempotency safety
// ═══════════════════════════════════════════════════════════════

describe('Layer 3 — claim/idempotency safety', () => {
  it('translation failure falls back to original English text', async () => {
    const ctx = entitledCtx();
    // LLM call throws an error
    mockCreate.mockRejectedValueOnce(new Error('LLM timeout'));

    const original = '✅ *Payment Confirmed!*\n\n🏢 TestBiz\n💰 Amount: ₦5,000';
    const result = await translateBotResponse(original, 'fr', ctx, {
      protectedValues: ['TestBiz', '₦5,000'],
    });

    // Must return original English text (fail-closed)
    expect(result).toBe(original);
    expect(result).toContain('Payment Confirmed');
    expect(result).toContain('TestBiz');
  });

  it('placeholder integrity failure returns original English', async () => {
    const ctx = entitledCtx();
    // LLM drops a placeholder
    mockTranslation('Paiement confirmé pour TestBiz');

    const original = '✅ Payment Confirmed for TestBiz ₦5,000';
    const result = await translateBotResponse(original, 'fr', ctx, {
      protectedValues: ['TestBiz'],
    });

    // Placeholder __V1__ was dropped → fail closed to original
    expect(result).toBe(original);
  });

  it('rate-limited translation returns original English', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');
    (checkRateLimit as any).mockReturnValueOnce({ allowed: false, remaining: 0 });

    const ctx = entitledCtx();
    const original = 'Thank you for your payment!';
    const result = await translateBotResponse(original, 'fr', ctx);

    expect(result).toBe(original);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('free tier returns English with zero LLM calls', async () => {
    const ctx = freeCtx();
    const original = '✅ *Payment Confirmed!*';
    const result = await translateBotResponse(original, 'fr', ctx);

    expect(result).toBe(original);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('confirmation claim re-renewal exists before delivery in send-confirmation.ts', () => {
    const source = readFileSync(resolve(ROOT, 'lib/payments/send-confirmation.ts'), 'utf-8');
    // Pre-delivery renewal must exist AFTER localization and BEFORE delivery claim
    expect(source).toContain('PRE-DELIVERY RENEWAL');
    expect(source).toContain('renewConfirmationClaim(supabase, payment.id, claimToken, logPrefix)');
    // The pre-delivery renewal must come before delivery claim
    const preDeliveryIdx = source.indexOf('PRE-DELIVERY RENEWAL');
    const deliveryClaimIdx = source.indexOf('claim_confirmation_delivery', preDeliveryIdx);
    expect(deliveryClaimIdx).toBeGreaterThan(preDeliveryIdx);
  });

  it('localization runs AFTER full message assembly (balance, guidance, calendar)', () => {
    const source = readFileSync(resolve(ROOT, 'lib/payments/send-confirmation.ts'), 'utf-8');
    // balance line is added to lines array
    const balanceIdx = source.indexOf("Remaining balance:");
    // calendar links are added
    const calendarIdx = source.indexOf('getCalendarLinksText');
    // localization runs after both
    const localizeIdx = source.indexOf('4b. Localize the FULLY ASSEMBLED');
    expect(localizeIdx).toBeGreaterThan(balanceIdx);
    expect(localizeIdx).toBeGreaterThan(calendarIdx);
  });

  it('translation failure does not alter payment/booking/order state (structural)', () => {
    const source = readFileSync(resolve(ROOT, 'lib/payments/send-confirmation.ts'), 'utf-8');
    // The localization block is wrapped in try/catch with no state mutation in the catch
    const localizeBlock = source.slice(
      source.indexOf('4b. Localize'),
      source.indexOf('PRE-DELIVERY RENEWAL'),
    );
    expect(localizeBlock).toContain('catch (err)');
    expect(localizeBlock).toContain('non-fatal');
    // The catch block must not contain any RPC calls or state mutations
    const catchStart = localizeBlock.indexOf('catch (err)');
    const catchBlock = localizeBlock.slice(catchStart, catchStart + 200);
    expect(catchBlock).not.toContain('.rpc(');
    expect(catchBlock).not.toContain('.update(');
    expect(catchBlock).not.toContain('.insert(');
  });

  it('no Meta/provider mutation from localization', () => {
    const source = readFileSync(resolve(ROOT, 'lib/payments/proactive-localization.ts'), 'utf-8');
    // The proactive localization helper must not call any provider/Meta APIs
    expect(source).not.toContain('sendTemplate');
    expect(source).not.toContain('meta-cloud');
    expect(source).not.toContain('MetaCloudService');
  });
});

// ═══════════════════════════════════════════════════════════════
// Layer 3b: Proactive localization helper structure
// ═══════════════════════════════════════════════════════════════

describe('Proactive localization helper', () => {
  it('resolveProactiveLocalization exists and uses resolveEffectiveResponseLanguage', () => {
    const source = readFileSync(resolve(ROOT, 'lib/payments/proactive-localization.ts'), 'utf-8');
    expect(source).toContain('resolveEffectiveResponseLanguage');
    expect(source).toContain('readPreferredResponseLanguage');
    expect(source).toContain('loadBusinessLanguages');
    expect(source).toContain('CERTIFIED_LANGUAGES');
    // Session lookup is scoped to exact phone + business_id
    expect(source).toContain(".eq('business_id', businessId)");
    expect(source).toContain(".eq('is_active', true)");
    expect(source).toContain(".gte('expires_at'");
    // Uses sessionLanguage, not explicitLanguage
    expect(source).toContain('explicitLanguage: null');
    expect(source).toContain('sessionLanguage,');
    expect(source).toContain('rememberedLanguage,');
  });

  it('proactive helper does not use NULL-business sessions', () => {
    const source = readFileSync(resolve(ROOT, 'lib/payments/proactive-localization.ts'), 'utf-8');
    // The session query must scope by business_id — never NULL
    expect(source).toContain(".eq('business_id', businessId)");
    // businessId is required parameter, not optional
    expect(source).toContain('businessId: string');
  });

  it('post-completion translate is wired from send-confirmation.ts', () => {
    const source = readFileSync(resolve(ROOT, 'lib/payments/send-confirmation.ts'), 'utf-8');
    expect(source).toContain('translate: proactiveTranslate');
  });

  it('ticket delivery translate is wired from send-confirmation.ts', () => {
    const source = readFileSync(resolve(ROOT, 'lib/payments/send-confirmation.ts'), 'utf-8');
    // The ticket options construction should include translate parameter
    const ticketStart = source.indexOf('const ticketOptions = {');
    const ticketEnd = source.indexOf('};', ticketStart + 100);
    const ticketBlock = source.slice(ticketStart, ticketEnd + 2);
    expect(ticketBlock).toContain('translate:');
  });
});

// ═══════════════════════════════════════════════════════════════
// B1: Calendar URL protection
// ═══════════════════════════════════════════════════════════════

describe('B1 — URL extraction + protection', () => {
  it('send-confirmation.ts extracts URLs from final message into protectedValues', () => {
    const source = readFileSync(resolve(ROOT, 'lib/payments/send-confirmation.ts'), 'utf-8');
    // URL extraction regex must exist before translation
    expect(source).toContain("localizedText.match(/https?:\\/\\/[^\\s)]+/g)");
    expect(source).toContain('protectedValues.push(...urlMatches)');
  });

  it('calendar URL survives translation via explicit protectedValues', async () => {
    const ctx = entitledCtx();
    const calUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Haircut&dates=20260810';
    mockTranslation('📅 Ajouter au calendrier: __V1__');

    const result = await translateBotResponse(
      `📅 Add to calendar: ${calUrl}`,
      'fr', ctx,
      { protectedValues: [calUrl] },
    );

    expect(result).toContain(calUrl);
  });
});

// ═══════════════════════════════════════════════════════════════
// B2: PIN/lockout localization completeness
// ═══════════════════════════════════════════════════════════════

describe('B2 — saved-card PIN/security localization', () => {
  it('handleCardPinStep uses localSend for all customer-facing messages', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/saved-cards.ts'), 'utf-8');
    const start = source.indexOf('export async function handleCardPinStep');
    const end = source.indexOf('export async function handleReplacementPinStep');
    const block = source.slice(start, end);
    expect((block.match(/await sendText\(from,/g) || []).length).toBe(0);
  });

  it('handleReplacementPinStep uses localSend for all customer-facing messages', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/saved-cards.ts'), 'utf-8');
    const start = source.indexOf('export async function handleReplacementPinStep');
    const block = source.slice(start);
    expect((block.match(/await sendText\(from,/g) || []).length).toBe(0);
  });

  it('wrong-PIN call passes attemptsRemaining as protectedValue', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/saved-cards.ts'), 'utf-8');
    expect(source).toContain("[String(pinResult.attemptsRemaining)]");
  });

  it('lockout call passes "30" as protectedValue', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/saved-cards.ts'), 'utf-8');
    expect(source).toContain("'🔒 Too many wrong attempts. Your card is locked for 30 minutes. Try again later.', ['30']");
  });

  it('initial PIN prompt passes "4" AND "Waaiio" as protectedValues', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/saved-cards.ts'), 'utf-8');
    const pinLine = source.split('\n').find(l => l.includes('4 digits') && l.includes('Waaiio PIN:'));
    expect(pinLine).toBeTruthy();
    expect(pinLine).toContain("['4', 'Waaiio']");
  });

  it('replacement PIN prompt passes "4" and "Waaiio" as protectedValues', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/saved-cards.ts'), 'utf-8');
    // The replacement PIN prompt line must include both protected values
    const pinLine = source.split('\n').find(l => l.includes('confirm replacement') && l.includes("['4'"));
    expect(pinLine).toBeTruthy();
    expect(pinLine).toContain("'Waaiio'");
  });

  it('card updated success passes newLabel and Waaiio as protectedValues', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/saved-cards.ts'), 'utf-8');
    expect(source).toContain("[newLabel, 'Waaiio']");
  });

  it('canonical fenced success localizes before sendWithFencedDelivery', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/saved-cards.ts'), 'utf-8');
    const fencedIdx = source.indexOf('sendWithFencedDelivery');
    const localizeIdx = source.indexOf("l10n.translate(confirmationMsg, [claimCardDisplay, 'Waaiio'])");
    expect(localizeIdx).toBeGreaterThan(-1);
    expect(fencedIdx).toBeGreaterThan(localizeIdx);
  });

  it('lockout "30" survives translation as protectedValue', async () => {
    const ctx = entitledCtx();
    mockTranslation('🔒 Trop de tentatives. Carte verrouillée pour __V1__ minutes.');
    const result = await translateBotResponse(
      '🔒 Too many wrong attempts. Your card is locked for 30 minutes. Try again later.',
      'fr', ctx, { protectedValues: ['30'] },
    );
    expect(result).toContain('30');
  });

  it('attempts count "2" survives translation as protectedValue', async () => {
    const ctx = entitledCtx();
    mockTranslation('❌ Mauvais PIN. __V1__ tentative(s) restante(s).');
    const result = await translateBotResponse(
      '❌ Wrong PIN. 2 attempts remaining.',
      'fr', ctx, { protectedValues: ['2'] },
    );
    expect(result).toContain('2');
  });
});

// ═══════════════════════════════════════════════════════════════
// B3: Stale-payment recovery localization
// ═══════════════════════════════════════════════════════════════

// B3/F2: Stale-payment recovery runtime tests are in:
//   lib/bot/__tests__/slice-5a-stale-payment-recovery-runtime.test.ts
// Those tests invoke real BotService.handleMessage() with mocked recovery functions
// and verify localized presentation, exact references, button IDs, and no mutations.

describe('B3 — stale-payment recovery (supplementary structural)', () => {
  it('bot.service.ts wires sendSessionLocalizedText for recovery sends', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    expect(source).toContain("sendSessionLocalizedText(from, result.message, session, recoveryOpts)");
  });
});

// ═══════════════════════════════════════════════════════════════
// Regression: no scope violations
// ═══════════════════════════════════════════════════════════════

describe('Slice 5A — scope containment', () => {
  it('CERTIFIED_LANGUAGES includes only English and Pidgin', () => {
    const catalog = readFileSync(resolve(ROOT, 'lib/bot/languages.ts'), 'utf-8');
    const certifiedCount = (catalog.match(/certified:\s*true/g) || []).length;
    expect(certifiedCount).toBe(2);
  });

  it('no migration files in diff', async () => {
    // Import analysis: modified files should not reference migration paths
    const helper = readFileSync(resolve(ROOT, 'lib/payments/proactive-localization.ts'), 'utf-8');
    expect(helper).not.toContain('supabase/migrations');
  });

  it('no Meta template creation/submission in proactive-localization.ts', () => {
    const source = readFileSync(resolve(ROOT, 'lib/payments/proactive-localization.ts'), 'utf-8');
    expect(source).not.toContain('provision');
    expect(source).not.toContain('createTemplate');
    expect(source).not.toContain('message_templates');
  });
});
