import { describe, expect, it } from 'vitest';
import { normalizeImportPhone } from '../import-phone';
describe('international import phone normalization', () => {
  it.each([
    ['+234 803 123 4567', '+2348031234567'], ['2348031234567', '+2348031234567'],
    ['+1 (415) 555-2671', '+14155552671'], ['1 (416) 555-0123', '+14165550123'],
    ['+233 24 123 4567', '+233241234567'], ['44 20 7946 0018', '+442079460018'],
  ])('normalizes %s', (input, expected) => expect(normalizeImportPhone(input)).toBe(expected));
  it.each(['+234801234567890123', '+12001234567', '08012345678', '2025550123', '02079460018', '00442079460018', '2.348012345678E+12', '+14155552671 ext 5', '+14155552671;ext=5', 'call +14155552671', '++14155552671', '', '  ', 14155552671, null, undefined, {}, ['+14155552671']])('rejects %j without guessing or extracting', input => expect(normalizeImportPhone(input)).toBeNull());
});
