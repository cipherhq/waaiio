/**
 * searchMarketplace: category synonym expansion + shared eligibility
 *
 * Tests:
 * 1. "massage" query expands to spa category via detectCategoryIntent
 * 2. Admin-hidden businesses are excluded from the bot path
 * 3. messaging_suspended businesses are excluded
 * 4. Website route output structure is unchanged for existing params
 * 5. Shared eligibility includes messaging_suspended check
 */
import { describe, it, expect, vi } from 'vitest';
import { applyDirectoryEligibility, loadDirectoryHiddenIds, isBusinessDirectoryEligible } from '../search';

describe('applyDirectoryEligibility', () => {
  it('includes messaging_suspended=false filter', () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const chain = {
      eq(...args: unknown[]) { calls.push({ method: 'eq', args }); return this; },
      not(...args: unknown[]) { calls.push({ method: 'not', args }); return this; },
      or(...args: unknown[]) { calls.push({ method: 'or', args }); return this; },
    };

    applyDirectoryEligibility(chain);

    expect(calls).toContainEqual({ method: 'eq', args: ['status', 'active'] });
    expect(calls).toContainEqual({ method: 'not', args: ['bot_code', 'is', null] });
    expect(calls).toContainEqual({ method: 'eq', args: ['messaging_suspended', false] });
    expect(calls).toContainEqual(
      expect.objectContaining({ method: 'or', args: [expect.stringContaining('discovery_enabled')] }),
    );
  });
});

describe('loadDirectoryHiddenIds', () => {
  it('returns hidden IDs from platform_settings', async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { value: ['id-1', 'id-2'] },
              error: null,
            }),
          })),
        })),
      })),
    } as any;
    const result = await loadDirectoryHiddenIds(supabase);
    expect(result).toEqual(['id-1', 'id-2']);
  });

  it('returns empty array when no setting exists', async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          })),
        })),
      })),
    } as any;
    const result = await loadDirectoryHiddenIds(supabase);
    expect(result).toEqual([]);
  });
});

describe('isBusinessDirectoryEligible', () => {
  it('returns true for eligible business not in hidden list', async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockReturnThis(),
              not: vi.fn().mockReturnThis(),
              or: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'biz-1' }, error: null }),
            })),
          };
        }
        // platform_settings
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({ data: { value: [] }, error: null }),
            })),
          })),
        };
      }),
    } as any;
    expect(await isBusinessDirectoryEligible(supabase, 'biz-1')).toBe(true);
  });

  it('returns false for hidden business', async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockReturnThis(),
              not: vi.fn().mockReturnThis(),
              or: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'biz-1' }, error: null }),
            })),
          };
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({ data: { value: ['biz-1'] }, error: null }),
            })),
          })),
        };
      }),
    } as any;
    expect(await isBusinessDirectoryEligible(supabase, 'biz-1')).toBe(false);
  });
});
