import { describe, it, expect } from 'vitest';
import { stripPlus, ensurePlus, phonePair } from '../phone';

describe('stripPlus', () => {
  it('removes leading +', () => {
    expect(stripPlus('+15712746425')).toBe('15712746425');
  });

  it('returns as-is without +', () => {
    expect(stripPlus('15712746425')).toBe('15712746425');
  });

  it('handles empty string', () => {
    expect(stripPlus('')).toBe('');
  });
});

describe('ensurePlus', () => {
  it('adds + when missing', () => {
    expect(ensurePlus('15712746425')).toBe('+15712746425');
  });

  it('returns as-is with +', () => {
    expect(ensurePlus('+15712746425')).toBe('+15712746425');
  });

  it('handles empty string', () => {
    expect(ensurePlus('')).toBe('+');
  });
});

describe('phonePair', () => {
  it('returns both formats from + number', () => {
    const result = phonePair('+2348012345678');
    expect(result.withPlus).toBe('+2348012345678');
    expect(result.withoutPlus).toBe('2348012345678');
  });

  it('returns both formats from non-+ number', () => {
    const result = phonePair('15712746425');
    expect(result.withPlus).toBe('+15712746425');
    expect(result.withoutPlus).toBe('15712746425');
  });
});
