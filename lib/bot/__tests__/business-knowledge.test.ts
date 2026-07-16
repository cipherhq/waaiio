import { describe, it, expect } from 'vitest';
import { isTemporaryQuestion } from '../business-knowledge';

describe('isTemporaryQuestion', () => {
  it('detects "what time do you close?" as hours', () => {
    const result = isTemporaryQuestion('what time do you close?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('hours');
  });

  it('detects "when do you open?" as hours', () => {
    const result = isTemporaryQuestion('when do you open?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('hours');
  });

  it('detects "are you still open?" as hours', () => {
    const result = isTemporaryQuestion('are you still open?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('hours');
  });

  it('detects "where are you located?" as location', () => {
    const result = isTemporaryQuestion('where are you located?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('location');
  });

  it('detects "what is your address?" as location', () => {
    const result = isTemporaryQuestion('what is your address?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('location');
  });

  it('detects "how much is a haircut?" as pricing', () => {
    const result = isTemporaryQuestion('how much is a haircut?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('pricing');
  });

  it('detects "what is the price?" as pricing', () => {
    const result = isTemporaryQuestion('what is the price?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('pricing');
  });

  it('detects "do you accept card?" as payment_methods', () => {
    const result = isTemporaryQuestion('do you accept card?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('payment_methods');
  });

  it('detects "can I pay with transfer?" as payment_methods', () => {
    const result = isTemporaryQuestion('can I pay with transfer?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('payment_methods');
  });

  it('detects "do you deliver?" as delivery', () => {
    const result = isTemporaryQuestion('do you deliver?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('delivery');
  });

  it('detects "is delivery available?" as delivery', () => {
    const result = isTemporaryQuestion('is delivery available?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('delivery');
  });

  it('detects "can I cancel?" as policy', () => {
    const result = isTemporaryQuestion('can I cancel?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('policy');
  });

  it('detects "what is your cancellation policy?" as policy', () => {
    const result = isTemporaryQuestion('what is your cancellation policy?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('policy');
  });

  it('returns null for "book a haircut" (not a question)', () => {
    const result = isTemporaryQuestion('book a haircut');
    expect(result).toBeNull();
  });

  it('returns null for "I want to order"', () => {
    const result = isTemporaryQuestion('I want to order');
    expect(result).toBeNull();
  });

  it('returns null for very short input', () => {
    const result = isTemporaryQuestion('hi');
    expect(result).toBeNull();
  });

  it('returns null for numeric input', () => {
    const result = isTemporaryQuestion('42');
    expect(result).toBeNull();
  });
});
