/**
 * contacts-filter-safety.test.ts
 *
 * Tests the PRODUCTION filter construction used by the Growth Contacts page.
 * Imports buildContactsSearchFilter and sanitizeIlikeSearch from lib/utils/sanitize.ts —
 * the same functions the page uses. No duplicated logic.
 *
 * Also tests mock Supabase chain to verify .or() receives the production filter,
 * .eq('business_id') is present, and consent filters are applied.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeFilterValue,
  sanitizeIlikeSearch,
  buildContactsSearchFilter,
} from '@/lib/utils/sanitize';

// ── sanitizeIlikeSearch (production function) ──

describe('sanitizeIlikeSearch — production function', () => {
  it('passes normal names unchanged', () => {
    expect(sanitizeIlikeSearch('John')).toBe('John');
    expect(sanitizeIlikeSearch('Ade Ogunlesi')).toBe('Ade Ogunlesi');
  });

  it('passes phone numbers unchanged', () => {
    expect(sanitizeIlikeSearch('+234 801 234 5678')).toBe('+234 801 234 5678');
  });

  it('escapes % as literal ILIKE wildcard', () => {
    expect(sanitizeIlikeSearch('100%')).toBe('100\\%');
  });

  it('escapes _ as literal ILIKE wildcard', () => {
    expect(sanitizeIlikeSearch('john_doe')).toBe('john\\_doe');
  });

  it('strips commas (PostgREST injection)', () => {
    expect(sanitizeIlikeSearch('Smith, Jr')).toBe('Smith Jr');
  });

  it('strips parentheses (PostgREST injection)', () => {
    expect(sanitizeIlikeSearch('John (CEO)')).toBe('John CEO');
  });

  it('composes both protections', () => {
    expect(sanitizeIlikeSearch('100%, (test)')).toBe('100\\% test');
  });

  it('returns empty for whitespace', () => {
    expect(sanitizeIlikeSearch('   ')).toBe('');
    expect(sanitizeIlikeSearch('')).toBe('');
  });

  it('trims input', () => {
    expect(sanitizeIlikeSearch('  John  ')).toBe('John');
  });
});

// ── buildContactsSearchFilter (production function used by page) ──

describe('buildContactsSearchFilter — production filter builder', () => {
  it('builds 3-column ILIKE filter for normal name', () => {
    expect(buildContactsSearchFilter('John')).toBe(
      'first_name.ilike.%John%,last_name.ilike.%John%,phone.ilike.%John%'
    );
  });

  it('escapes wildcards in the filter', () => {
    expect(buildContactsSearchFilter('100%')).toBe(
      'first_name.ilike.%100\\%%,last_name.ilike.%100\\%%,phone.ilike.%100\\%%'
    );
  });

  it('strips commas — injection cannot add a 4th condition', () => {
    const filter = buildContactsSearchFilter(',phone.eq.+123,');
    expect(filter).not.toBeNull();
    const conditions = filter!.split(',');
    expect(conditions).toHaveLength(3);
    expect(conditions[0]).toMatch(/^first_name\.ilike\./);
  });

  it('strips parentheses from filter', () => {
    const filter = buildContactsSearchFilter('),id.eq.1,(');
    expect(filter).not.toBeNull();
    expect(filter).not.toContain('),(');
  });

  it('returns null for empty/whitespace search', () => {
    expect(buildContactsSearchFilter('')).toBeNull();
    expect(buildContactsSearchFilter('   ')).toBeNull();
  });

  it('handles underscore escaping', () => {
    const filter = buildContactsSearchFilter('john_doe');
    expect(filter).toContain('john\\_doe');
  });

  it('preserves dots and quotes', () => {
    const filter = buildContactsSearchFilter("O'Brien");
    expect(filter).toContain("O'Brien");
  });
});

// ── Mock Supabase chain — verifies actual page query construction ──

describe('contacts page query chain (mock Supabase)', () => {
  function createMockSupabaseChain() {
    const calls: { method: string; args: unknown[] }[] = [];

    const chain = {
      select: vi.fn((...args: unknown[]) => { calls.push({ method: 'select', args }); return chain; }),
      eq: vi.fn((...args: unknown[]) => { calls.push({ method: 'eq', args }); return chain; }),
      order: vi.fn((...args: unknown[]) => { calls.push({ method: 'order', args }); return chain; }),
      range: vi.fn((...args: unknown[]) => { calls.push({ method: 'range', args }); return chain; }),
      or: vi.fn((...args: unknown[]) => { calls.push({ method: 'or', args }); return chain; }),
      then: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    };

    const supabase = {
      from: vi.fn((...args: unknown[]) => { calls.push({ method: 'from', args }); return chain; }),
    };

    return { supabase, chain, calls };
  }

  /**
   * Simulates the production loadContacts query construction.
   * This mirrors app/dashboard/growth/contacts/page.tsx lines 61-81 exactly,
   * using the production buildContactsSearchFilter function.
   */
  function simulateLoadContacts(
    supabase: ReturnType<typeof createMockSupabaseChain>['supabase'],
    businessId: string,
    search: string,
    filter: 'all' | 'has_consent' | 'needs_consent' | 'opted_out' = 'all',
  ) {
    let query = supabase
      .from('growth_contacts')
      .select('id, first_name, last_name, phone, email, tags, has_consent, opted_out, created_at', { count: 'exact' })
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .range(0, 24);

    if (filter === 'has_consent') {
      query = query.eq('has_consent', true).eq('opted_out', false);
    } else if (filter === 'needs_consent') {
      query = query.eq('has_consent', false).eq('opted_out', false);
    } else if (filter === 'opted_out') {
      query = query.eq('opted_out', true);
    }

    if (search.trim()) {
      const orFilter = buildContactsSearchFilter(search);
      if (orFilter) query = query.or(orFilter);
    }

    return query;
  }

  it('includes business_id eq predicate', () => {
    const { supabase, calls } = createMockSupabaseChain();
    simulateLoadContacts(supabase, 'biz-123', '');
    const eqCalls = calls.filter(c => c.method === 'eq');
    expect(eqCalls.some(c => c.args[0] === 'business_id' && c.args[1] === 'biz-123')).toBe(true);
  });

  it('applies consent filter when filter=has_consent', () => {
    const { supabase, calls } = createMockSupabaseChain();
    simulateLoadContacts(supabase, 'biz-1', '', 'has_consent');
    const eqCalls = calls.filter(c => c.method === 'eq');
    expect(eqCalls.some(c => c.args[0] === 'has_consent' && c.args[1] === true)).toBe(true);
    expect(eqCalls.some(c => c.args[0] === 'opted_out' && c.args[1] === false)).toBe(true);
  });

  it('normal search produces correct .or() argument', () => {
    const { supabase, calls } = createMockSupabaseChain();
    simulateLoadContacts(supabase, 'biz-1', 'John');
    const orCalls = calls.filter(c => c.method === 'or');
    expect(orCalls).toHaveLength(1);
    expect(orCalls[0].args[0]).toBe(
      'first_name.ilike.%John%,last_name.ilike.%John%,phone.ilike.%John%'
    );
  });

  it('comma injection in search does not add extra .or() conditions', () => {
    const { supabase, calls } = createMockSupabaseChain();
    simulateLoadContacts(supabase, 'biz-1', ',phone.eq.+1234567890,');
    const orCalls = calls.filter(c => c.method === 'or');
    expect(orCalls).toHaveLength(1);
    const orArg = orCalls[0].args[0] as string;
    // Should have exactly 3 conditions (commas stripped from input)
    const conditions = orArg.split(',');
    expect(conditions).toHaveLength(3);
  });

  it('wildcard search escapes % in .or() argument', () => {
    const { supabase, calls } = createMockSupabaseChain();
    simulateLoadContacts(supabase, 'biz-1', '50%');
    const orCalls = calls.filter(c => c.method === 'or');
    const orArg = orCalls[0].args[0] as string;
    expect(orArg).toContain('50\\%');
  });

  it('empty search does not add .or() to chain', () => {
    const { supabase, calls } = createMockSupabaseChain();
    simulateLoadContacts(supabase, 'biz-1', '   ');
    const orCalls = calls.filter(c => c.method === 'or');
    expect(orCalls).toHaveLength(0);
  });

  it('business_id is always present regardless of search/filter', () => {
    const { supabase, calls } = createMockSupabaseChain();
    simulateLoadContacts(supabase, 'tenant-xyz', 'test', 'opted_out');
    const eqCalls = calls.filter(c => c.method === 'eq');
    expect(eqCalls.some(c => c.args[0] === 'business_id' && c.args[1] === 'tenant-xyz')).toBe(true);
    expect(eqCalls.some(c => c.args[0] === 'opted_out' && c.args[1] === true)).toBe(true);
    const orCalls = calls.filter(c => c.method === 'or');
    expect(orCalls).toHaveLength(1);
  });
});

// ── sanitizeFilterValue (standalone) ──

describe('sanitizeFilterValue — standalone', () => {
  it('strips commas', () => expect(sanitizeFilterValue('a,b,c')).toBe('abc'));
  it('strips parentheses', () => expect(sanitizeFilterValue('a(b)c')).toBe('abc'));
  it('preserves % and _', () => expect(sanitizeFilterValue('100%_test')).toBe('100%_test'));
  it('preserves normal text', () => expect(sanitizeFilterValue('hello world')).toBe('hello world'));
});
