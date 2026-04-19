import { describe, it, expect } from 'vitest';

/**
 * Test the keyword detection regex patterns used in bot.service.ts.
 * These are extracted here to test in isolation without needing
 * to instantiate the full BotService class.
 */

const isLoyaltyQuery = (text: string) =>
  /^(my\s+)?(loyalty|points|rewards?|stars?)$/i.test(text)
  || /^(check|view|show)\s+(my\s+)?(loyalty|points|rewards?|balance)$/i.test(text);

const isInvoiceQuery = (text: string) =>
  /^(my\s+)?(invoices?|bills?)$/i.test(text)
  || /^(check|view|show|pay)\s+(my\s+)?(invoices?|bills?)$/i.test(text);

describe('Loyalty keyword detection', () => {
  const positives = [
    'points',
    'my points',
    'rewards',
    'my rewards',
    'loyalty',
    'my loyalty',
    'reward',
    'stars',
    'my stars',
    'check points',
    'check my points',
    'view rewards',
    'show my balance',
    'view loyalty',
    'show rewards',
    'check my loyalty',
  ];

  const negatives = [
    'hi',
    'book appointment',
    'I want to check on my order',
    'loyalty card number 12345',
    'show me services',
    'point me to the menu',
  ];

  for (const input of positives) {
    it(`matches: "${input}"`, () => {
      expect(isLoyaltyQuery(input)).toBe(true);
    });
  }

  for (const input of negatives) {
    it(`does not match: "${input}"`, () => {
      expect(isLoyaltyQuery(input)).toBe(false);
    });
  }
});

describe('Invoice keyword detection', () => {
  const positives = [
    'invoices',
    'invoice',
    'my invoices',
    'my invoice',
    'bills',
    'bill',
    'my bills',
    'my bill',
    'check invoices',
    'check my invoices',
    'view my bills',
    'show invoices',
    'pay invoice',
    'pay my bills',
    'pay bills',
  ];

  const negatives = [
    'hi',
    'book',
    'I have a billing question',
    'invoice number 12345',
    'send me the invoice for order 99',
    'bill of materials',
  ];

  for (const input of positives) {
    it(`matches: "${input}"`, () => {
      expect(isInvoiceQuery(input)).toBe(true);
    });
  }

  for (const input of negatives) {
    it(`does not match: "${input}"`, () => {
      expect(isInvoiceQuery(input)).toBe(false);
    });
  }
});
