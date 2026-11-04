/**
 * M509 — restaurant "table" keyword is whole-word only (Owner decision 2026-11-04).
 * Unit proof through the real keyword-service matcher, using the exact pattern
 * the migration stores. The generic 'contains' semantics are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { matchUnifiedKeyword } from '@/lib/bot/keyword-service';

const sql = readFileSync('supabase/migrations/509_table_keyword_whole_word.sql', 'utf8');
/** The value M509 writes: E'\\btables?\\b' → \btables?\b */
const STORED = /SET keyword = E'([^']+)'/.exec(sql)![1].replace(/\\\\/g, '\\');

function kw(keyword: string, match_type: 'contains' | 'regex' | 'exact', capability: string, priority = 55) {
  return {
    id: keyword, keyword, match_type, action_type: 'start_capability' as const,
    payload: JSON.stringify({ capability }), priority, scope: 'category' as const,
    category: 'restaurant', business_id: null, campaign_id: null, description: null,
  };
}

describe('M509 table keyword (keyword-service)', () => {
  it('stores the word-boundary pattern', () => {
    expect(STORED).toBe('\\btables?\\b');
  });

  const tableKw = kw(STORED, 'regex', 'table_reservation');

  it.each([
    'table for 4', 'Table for 4 tonight', 'can I book a table?', 'TABLE', 'any tables free on friday',
    'reserve a table, please', 'table-for-two',
  ])('still matches "%s"', text => {
    expect(matchUnifiedKeyword(text, [tableKw])?.id).toBe(STORED);
  });

  it.each([
    'vegetable', 'vegetable soup please', 'comfortable seats?', 'timetable', 'stable', 'notable dishes', 'portable', 'tablespoon',
  ])('no longer matches "%s"', text => {
    expect(matchUnifiedKeyword(text, [tableKw])).toBeNull();
  });

  it('the old substring row matched "vegetable" (the defect being fixed)', () => {
    expect(matchUnifiedKeyword('vegetable soup', [kw('table', 'contains', 'table_reservation')])).not.toBeNull();
  });

  it('generic contains matching is unchanged for other keywords', () => {
    const delivery = kw('delivery', 'contains', 'ordering', 60);
    expect(matchUnifiedKeyword('need a deliveryman', [delivery])?.id).toBe('delivery');
    const dineIn = kw('dine-in', 'contains', 'table_reservation', 60);
    expect(matchUnifiedKeyword('we want to dine-in tonight', [dineIn, tableKw])?.id).toBe('dine-in');
  });
});
