import { describe, it, expect } from 'vitest';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

describe('sanitizeFilterValue', () => {
  it('passes clean values through', () => {
    expect(sanitizeFilterValue('+2341234567890')).toBe('+2341234567890');
    expect(sanitizeFilterValue('hello')).toBe('hello');
    expect(sanitizeFilterValue('test@email.com')).toBe('test@email.com');
  });

  it('strips Supabase filter injection characters', () => {
    // These characters could break .or() filters
    const malicious = 'value),phone.eq.admin_phone';
    const sanitized = sanitizeFilterValue(malicious);
    expect(sanitized).not.toContain(')');
    expect(sanitized).not.toContain(',');
  });

  it('handles empty strings', () => {
    expect(sanitizeFilterValue('')).toBe('');
  });

  it('handles special characters safely', () => {
    const result = sanitizeFilterValue("O'Brien");
    expect(typeof result).toBe('string');
  });
});
