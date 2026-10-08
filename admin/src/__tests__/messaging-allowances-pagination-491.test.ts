import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Source contract guards the admin's actual Supabase query against regression.
// Full >1,000-row execution remains for staging/database integration verification.
const source = fs.readFileSync(path.resolve(__dirname, '../pages/MessagingCredits.tsx'), 'utf8');
const fetchBlock = source.split('// Paginate allowance rows independently')[1]?.split('const byBiz =')[0] ?? '';

describe('Messaging Credits allowance pagination regression (#491)', () => {
  it('uses a bounded page size below the common PostgREST row cap', () => {
    expect(fetchBlock).toContain('const allowancePageSize = 500');
    expect(fetchBlock).toContain('.range(allowanceOffset, allowanceOffset + allowancePageSize - 1)');
  });

  it('retrieves subsequent pages until a short page is returned', () => {
    expect(fetchBlock).toContain('while (true)');
    expect(fetchBlock).toContain('pageAllowances.push(...(chunk as AllowanceRow[]))');
    expect(fetchBlock).toContain('if (chunk.length < allowancePageSize) break');
    expect(fetchBlock).toContain('allowanceOffset += chunk.length');
  });

  it('uses stable total ordering and scopes results to the selected businesses', () => {
    expect(fetchBlock).toContain(".in('business_id', pageBizIds)");
    expect(fetchBlock).toContain(".order('created_at', { ascending: true })");
    expect(fetchBlock).toContain(".order('id', { ascending: true })");
  });

  it('fails visibly instead of showing partial results on query failure', () => {
    expect(fetchBlock).toContain('if (allowErr)');
    expect(fetchBlock).toContain('if (!chunk)');
    expect(fetchBlock).toContain('setAllowancesByBiz(new Map())');
    expect(fetchBlock).toContain('setError(');
  });
});
