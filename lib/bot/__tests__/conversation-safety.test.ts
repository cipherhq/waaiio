import { describe, it, expect } from 'vitest';
import {
  isSensitiveIndustry,
  getSensitiveDisclaimer,
  buildTransactionSummary,
} from '../conversation-safety';

describe('isSensitiveIndustry', () => {
  it('returns true for clinic', () => {
    expect(isSensitiveIndustry('clinic')).toBe(true);
  });

  it('returns true for dental', () => {
    expect(isSensitiveIndustry('dental')).toBe(true);
  });

  it('returns true for pharmacy', () => {
    expect(isSensitiveIndustry('pharmacy')).toBe(true);
  });

  it('returns true for legal', () => {
    expect(isSensitiveIndustry('legal')).toBe(true);
  });

  it('returns true for therapy', () => {
    expect(isSensitiveIndustry('therapy')).toBe(true);
  });

  it('returns false for restaurant', () => {
    expect(isSensitiveIndustry('restaurant')).toBe(false);
  });

  it('returns false for salon', () => {
    expect(isSensitiveIndustry('salon')).toBe(false);
  });

  it('returns false for shop', () => {
    expect(isSensitiveIndustry('shop')).toBe(false);
  });
});

describe('getSensitiveDisclaimer', () => {
  it('returns medical disclaimer for health categories', () => {
    for (const cat of ['clinic', 'dental', 'therapy', 'physiotherapy', 'optician', 'medspa', 'pharmacy']) {
      const disclaimer = getSensitiveDisclaimer(cat);
      expect(disclaimer).not.toBeNull();
      expect(disclaimer).toContain('medical');
    }
  });

  it('returns legal disclaimer for legal categories', () => {
    for (const cat of ['legal', 'accounting']) {
      const disclaimer = getSensitiveDisclaimer(cat);
      expect(disclaimer).not.toBeNull();
      expect(disclaimer).toContain('legal');
    }
  });

  it('returns null for non-sensitive categories', () => {
    expect(getSensitiveDisclaimer('restaurant')).toBeNull();
    expect(getSensitiveDisclaimer('salon')).toBeNull();
    expect(getSensitiveDisclaimer('shop')).toBeNull();
  });
});

describe('buildTransactionSummary', () => {
  it('includes all provided fields', () => {
    const summary = buildTransactionSummary({
      businessName: 'Ace Salon',
      service: 'Haircut',
      date: 'Monday',
      time: '3:00 PM',
      quantity: 2,
      amount: 5000,
      currency: '$',
      deposit: 1000,
      cancellationPolicy: 'No refunds within 24hrs',
    });

    expect(summary).toContain('Ace Salon');
    expect(summary).toContain('Haircut');
    expect(summary).toContain('Monday');
    expect(summary).toContain('3:00 PM');
    expect(summary).toContain('Quantity: 2');
    expect(summary).toContain('$5,000');
    expect(summary).toContain('$1,000');
    expect(summary).toContain('No refunds within 24hrs');
  });

  it('omits missing fields', () => {
    const summary = buildTransactionSummary({
      businessName: 'Ace Salon',
    });

    expect(summary).toContain('Ace Salon');
    expect(summary).not.toContain('Service:');
    expect(summary).not.toContain('Date:');
    expect(summary).not.toContain('Time:');
    expect(summary).not.toContain('Quantity:');
    expect(summary).not.toContain('Amount:');
    expect(summary).not.toContain('Deposit');
  });

  it('formats amounts with currency', () => {
    const summary = buildTransactionSummary({
      businessName: 'Test',
      amount: 15000,
      currency: '$',
    });

    expect(summary).toContain('$15,000');
  });

  it('uses naira sign as default currency', () => {
    const summary = buildTransactionSummary({
      businessName: 'Test',
      amount: 5000,
    });

    // Default currency is ₦
    expect(summary).toContain('\u20A65,000');
  });

  it('does not show quantity when 1', () => {
    const summary = buildTransactionSummary({
      businessName: 'Test',
      quantity: 1,
    });

    expect(summary).not.toContain('Quantity');
  });

  it('includes product field when provided', () => {
    const summary = buildTransactionSummary({
      businessName: 'Test Shop',
      product: 'Widget',
    });

    expect(summary).toContain('Item: Widget');
  });
});
