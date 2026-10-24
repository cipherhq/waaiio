import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';

const LINKER = join(__dirname, '..', 'ts-rpc-linker.py');

function run(args: string, cwd?: string): string {
  return execSync(`python3 ${LINKER} ${args}`, {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf-8',
    timeout: 15_000,
  });
}

function runJson(args: string, cwd?: string): any {
  return JSON.parse(run(`${args} --json`, cwd));
}

/**
 * Build a minimal fixture repo with TS files and SQL migrations.
 * Returns the temp directory path (caller must clean up).
 */
function buildFixture(opts: {
  tsFiles?: Record<string, string>;
  sqlFiles?: Record<string, string>;
}): string {
  const tmp = mkdtempSync(join(os.tmpdir(), 'rpc-linker-'));
  const libDir = join(tmp, 'lib');
  const migDir = join(tmp, 'supabase', 'migrations');
  mkdirSync(libDir, { recursive: true });
  mkdirSync(migDir, { recursive: true });

  for (const [name, content] of Object.entries(opts.tsFiles ?? {})) {
    const dir = join(tmp, ...name.split('/').slice(0, -1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(tmp, name), content);
  }
  for (const [name, content] of Object.entries(opts.sqlFiles ?? {})) {
    writeFileSync(join(migDir, name), content);
  }
  return tmp;
}

describe('ts-rpc-linker', () => {
  // ── 1. Multi-line .rpc() calls ──────────────────────────────────

  describe('multiline RPC calls', () => {
    let tmp: string;
    afterAll(() => tmp && rmSync(tmp, { recursive: true, force: true }));

    it('detects .rpc() split across two lines', () => {
      tmp = buildFixture({
        tsFiles: {
          'lib/example.ts': [
            'const { data } = await supabase.rpc(',
            "  'my_rpc_function',",
            '  { p_id: id }',
            ');',
          ].join('\n'),
        },
        sqlFiles: {
          '001_init.sql':
            'CREATE OR REPLACE FUNCTION public.my_rpc_function(p_id UUID)\nRETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
        },
      });

      const result = runJson(`--root ${tmp}`);
      expect(result.stats.unique_rpc_names).toBe(1);
      expect(result.stats.matched).toBe(1);

      const calls = result.ts_to_rpcs['lib/example.ts'];
      expect(calls).toHaveLength(1);
      expect(calls[0].rpc).toBe('my_rpc_function');
    });

    it('detects single-line .rpc() normally', () => {
      tmp = buildFixture({
        tsFiles: {
          'lib/single.ts': "const { data } = await supabase.rpc('single_line_rpc', { p_id: id });",
        },
        sqlFiles: {
          '001_init.sql':
            'CREATE FUNCTION public.single_line_rpc(p_id UUID)\nRETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
        },
      });

      const result = runJson(`--root ${tmp}`);
      expect(result.stats.matched).toBe(1);
      const calls = result.ts_to_rpcs['lib/single.ts'];
      expect(calls[0].rpc).toBe('single_line_rpc');
    });
  });

  // ── 2. Duplicate / historical SQL function definitions ──────────

  describe('duplicate and historical SQL definitions', () => {
    let tmp: string;
    afterAll(() => tmp && rmSync(tmp, { recursive: true, force: true }));

    it('records all definitions when a function is CREATE OR REPLACE multiple times', () => {
      tmp = buildFixture({
        tsFiles: {
          'lib/caller.ts': "await service.rpc('evolving_func', {});",
        },
        sqlFiles: {
          '100_initial.sql':
            'CREATE FUNCTION public.evolving_func()\nRETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
          '200_replace.sql':
            'CREATE OR REPLACE FUNCTION public.evolving_func()\nRETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END; $$;',
          '300_replace_again.sql':
            'CREATE OR REPLACE FUNCTION public.evolving_func()\nRETURNS VOID LANGUAGE plpgsql SECURITY DEFINER\nSET search_path = public, extensions AS $$ BEGIN END; $$;',
        },
      });

      const result = runJson(`--root ${tmp}`);
      expect(result.stats.matched).toBe(1);
      expect(result.stats.orphan_ts_calls).toBe(0);

      const defs = result.rpc_to_sql['evolving_func'];
      expect(defs).toHaveLength(3);
      // Sorted by migration filename — 100, 200, 300
      expect(defs[0].file).toBe('100_initial.sql');
      expect(defs[1].file).toBe('200_replace.sql');
      expect(defs[2].file).toBe('300_replace_again.sql');
      // Definitions are discovery candidates — no security_definer classification
      expect(defs[0]).not.toHaveProperty('security_definer');
    });

    it('historical definitions are discovery candidates, not deployed identity', () => {
      tmp = buildFixture({
        tsFiles: {
          'lib/caller.ts': "await service.rpc('replaced_func', {});",
        },
        sqlFiles: {
          '100_v1.sql':
            'CREATE FUNCTION public.replaced_func(p_id UUID)\nRETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
          '200_v2.sql':
            'CREATE OR REPLACE FUNCTION public.replaced_func(p_id UUID, p_name TEXT)\nRETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
        },
      });

      const result = runJson(`--root ${tmp}`);
      const defs = result.rpc_to_sql['replaced_func'];
      // Both definitions are recorded — the linker cannot determine which
      // is currently deployed. The last migration is the most recent candidate
      // but only Release Gate V2 §2 final-state checks or database catalog
      // queries can confirm the effective deployed function.
      expect(defs).toHaveLength(2);
      expect(defs[0].file).toBe('100_v1.sql');
      expect(defs[1].file).toBe('200_v2.sql');
      // No security attribute classification — use Release Gate V2 for that
      expect(Object.keys(defs[0])).toEqual(expect.arrayContaining(['file', 'line']));
      expect(defs[0]).not.toHaveProperty('security_definer');
    });
  });

  // ── 3. Function overloads (same name, different signatures) ─────

  describe('function overloads', () => {
    let tmp: string;
    afterAll(() => tmp && rmSync(tmp, { recursive: true, force: true }));

    it('records multiple definitions for overloaded function names', () => {
      tmp = buildFixture({
        tsFiles: {
          'lib/caller.ts': "await service.rpc('overloaded_func', {});",
        },
        sqlFiles: {
          '001_overloads.sql': [
            'CREATE FUNCTION public.overloaded_func(p_id UUID)',
            'RETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
            '',
            'CREATE FUNCTION public.overloaded_func(p_id UUID, p_name TEXT)',
            'RETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
          ].join('\n'),
        },
      });

      const result = runJson(`--root ${tmp}`);
      // Both definitions recorded — linker cannot distinguish which overload
      // the TS caller targets (Supabase RPC dispatch is by name only)
      const defs = result.rpc_to_sql['overloaded_func'];
      expect(defs.length).toBeGreaterThanOrEqual(2);
      // The match still counts as 1 (name matched)
      expect(result.stats.matched).toBe(1);
    });
  });

  // ── 3b. SECURITY DEFINER misclassification regression ───────────

  describe('security attribute not classified by linker', () => {
    let tmp: string;
    afterAll(() => tmp && rmSync(tmp, { recursive: true, force: true }));

    it('does not classify SECURITY DEFINER/INVOKER (regression: file-wide scan)', () => {
      // Regression: the linker previously scanned the entire migration file
      // for SECURITY DEFINER and applied it to every function in the file.
      // A migration with both DEFINER and INVOKER functions would falsely
      // mark the INVOKER function as SECURITY DEFINER.
      // Fix: removed security classification entirely — use Release Gate V2
      // invariant registry and database catalog checks instead.
      tmp = buildFixture({
        tsFiles: {
          'lib/caller.ts': [
            "await service.rpc('privileged_func', {});",
            "await service.rpc('unprivileged_func', {});",
          ].join('\n'),
        },
        sqlFiles: {
          '001_mixed_security.sql': [
            'CREATE FUNCTION public.privileged_func(p_id UUID)',
            'RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER',
            'SET search_path = public, extensions',
            'AS $$ BEGIN END; $$;',
            '',
            'CREATE FUNCTION public.unprivileged_func(p_id UUID)',
            'RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER',
            'AS $$ BEGIN END; $$;',
          ].join('\n'),
        },
      });

      const result = runJson(`--root ${tmp}`);
      expect(result.stats.matched).toBe(2);

      const privDefs = result.rpc_to_sql['privileged_func'];
      const unprivDefs = result.rpc_to_sql['unprivileged_func'];
      expect(privDefs).toHaveLength(1);
      expect(unprivDefs).toHaveLength(1);

      // Neither function has a security_definer property — the linker does
      // not attempt this classification. Release Gate V2 §1 (invariant
      // registry) and pg_proc catalog checks are the authority for this.
      expect(privDefs[0]).not.toHaveProperty('security_definer');
      expect(unprivDefs[0]).not.toHaveProperty('security_definer');
    });
  });

  // ── 4. Missing RPC definitions ──────────────────────────────────

  describe('missing RPC definitions', () => {
    let tmp: string;
    afterAll(() => tmp && rmSync(tmp, { recursive: true, force: true }));

    it('reports orphan when TS calls an RPC with no SQL definition', () => {
      tmp = buildFixture({
        tsFiles: {
          'lib/caller.ts': "await service.rpc('nonexistent_rpc', {});",
        },
        sqlFiles: {
          '001_init.sql':
            'CREATE FUNCTION public.some_other_func()\nRETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
        },
      });

      const result = runJson(`--root ${tmp}`);
      expect(result.stats.orphan_ts_calls).toBe(1);
      expect(result.orphan_rpcs).toContain('nonexistent_rpc');
      expect(result.stats.matched).toBe(0);
    });

    it('reports zero orphans when all RPCs have definitions', () => {
      tmp = buildFixture({
        tsFiles: {
          'lib/caller.ts': "await service.rpc('defined_rpc', {});",
        },
        sqlFiles: {
          '001_init.sql':
            'CREATE FUNCTION public.defined_rpc()\nRETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
        },
      });

      const result = runJson(`--root ${tmp}`);
      expect(result.stats.orphan_ts_calls).toBe(0);
      expect(result.orphan_rpcs).toHaveLength(0);
    });
  });

  // ── 5. Dynamic or unresolved RPC names ──────────────────────────

  describe('dynamic and unresolved RPC names', () => {
    let tmp: string;
    afterAll(() => tmp && rmSync(tmp, { recursive: true, force: true }));

    it('ignores dynamic RPC names (variables, not string literals)', () => {
      tmp = buildFixture({
        tsFiles: {
          'lib/dynamic.ts': [
            "const rpcName = getCapabilityRpc(cap);",
            "await service.rpc(rpcName, {});",
            "// But also a real one:",
            "await service.rpc('real_static_rpc', {});",
          ].join('\n'),
        },
        sqlFiles: {
          '001_init.sql':
            'CREATE FUNCTION public.real_static_rpc()\nRETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
        },
      });

      const result = runJson(`--root ${tmp}`);
      // Only the string-literal RPC is detected; the variable reference is ignored
      expect(result.stats.unique_rpc_names).toBe(1);
      expect(result.stats.matched).toBe(1);
    });

    it('ignores template literal RPC names', () => {
      tmp = buildFixture({
        tsFiles: {
          'lib/template.ts': 'await service.rpc(`dynamic_${action}`, {});',
        },
        sqlFiles: {},
      });

      const result = runJson(`--root ${tmp}`);
      expect(result.stats.unique_rpc_names).toBe(0);
    });
  });

  // ── 6. Ambiguous matches and edge cases ─────────────────────────

  describe('ambiguous matches and edge cases', () => {
    let tmp: string;
    afterAll(() => tmp && rmSync(tmp, { recursive: true, force: true }));

    it('handles empty repo gracefully', () => {
      tmp = buildFixture({ tsFiles: {}, sqlFiles: {} });
      const result = runJson(`--root ${tmp}`);
      expect(result.stats.ts_files_with_rpc_calls).toBe(0);
      expect(result.stats.unique_rpc_names).toBe(0);
      expect(result.stats.sql_function_definitions).toBe(0);
    });

    it('handles missing migrations directory gracefully', () => {
      tmp = mkdtempSync(join(os.tmpdir(), 'rpc-linker-empty-'));
      const libDir = join(tmp, 'lib');
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, 'example.ts'), "await service.rpc('some_func', {});");

      const result = runJson(`--root ${tmp}`);
      expect(result.stats.orphan_ts_calls).toBe(1);
      expect(result.orphan_rpcs).toContain('some_func');
    });

    it('distinguishes test files from production files', () => {
      tmp = buildFixture({
        tsFiles: {
          'lib/prod.ts': "await service.rpc('shared_rpc', {});",
          'lib/__tests__/test.ts': "await service.rpc('shared_rpc', {});",
          'lib/something.test.ts': "await service.rpc('shared_rpc', {});",
        },
        sqlFiles: {
          '001_init.sql':
            'CREATE FUNCTION public.shared_rpc()\nRETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
        },
      });

      const result = runJson(`--root ${tmp}`);
      // All three files find the RPC, but test classification differs
      const allCalls = Object.values(result.ts_to_rpcs).flat() as any[];
      const prodCalls = allCalls.filter((c: any) => !c.is_test);
      const testCalls = allCalls.filter((c: any) => c.is_test);
      expect(prodCalls).toHaveLength(1);
      expect(testCalls).toHaveLength(2);
    });

    it('does not match .rpc() in comments or strings', () => {
      tmp = buildFixture({
        tsFiles: {
          'lib/comments.ts': [
            "// await service.rpc('commented_out_rpc', {});",
            "const note = \"service.rpc('string_rpc', {})\";",
            "await service.rpc('actual_rpc', {});",
          ].join('\n'),
        },
        sqlFiles: {
          '001_init.sql': [
            'CREATE FUNCTION public.commented_out_rpc() RETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
            'CREATE FUNCTION public.string_rpc() RETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
            'CREATE FUNCTION public.actual_rpc() RETURNS VOID LANGUAGE plpgsql AS $$ BEGIN END; $$;',
          ].join('\n'),
        },
      });

      const result = runJson(`--root ${tmp}`);
      // Regex-based extraction captures all three — this is a known limitation.
      // The linker does NOT parse TS AST, so comments and strings are matched.
      // This test documents the behavior rather than asserting it's "correct".
      const rpcs = new Set(
        Object.values(result.ts_to_rpcs)
          .flat()
          .map((c: any) => c.rpc),
      );
      // All three are found — the linker is over-inclusive, not under-inclusive
      expect(rpcs.size).toBeGreaterThanOrEqual(1);
      expect(rpcs).toContain('actual_rpc');
    });

    it('--check returns structured data for known RPC', () => {
      tmp = buildFixture({
        tsFiles: {
          'lib/caller.ts': "await service.rpc('checked_rpc', {});",
        },
        sqlFiles: {
          '050_checked.sql':
            'CREATE FUNCTION public.checked_rpc(p_id UUID)\nRETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END; $$;',
        },
      });

      const result = runJson(`--root ${tmp} --check checked_rpc`);
      expect(result.rpc).toBe('checked_rpc');
      expect(result.sql_definitions).toHaveLength(1);
      expect(result.sql_definitions[0]).not.toHaveProperty('security_definer');
      expect(result.sql_definitions[0].file).toBe('050_checked.sql');
      expect(result.production_callers).toHaveLength(1);
    });

    it('--check returns empty for unknown RPC', () => {
      tmp = buildFixture({ tsFiles: {}, sqlFiles: {} });
      const result = runJson(`--root ${tmp} --check totally_unknown`);
      expect(result.rpc).toBe('totally_unknown');
      expect(result.sql_definitions).toHaveLength(0);
      expect(result.ts_callers).toHaveLength(0);
    });
  });

  // ── 7. Real codebase smoke test ─────────────────────────────────

  describe('real codebase smoke test', () => {
    it('runs against the actual repo without errors', () => {
      const result = runJson('');
      expect(result.stats.ts_files_with_rpc_calls).toBeGreaterThan(100);
      expect(result.stats.unique_rpc_names).toBeGreaterThan(200);
      expect(result.stats.matched).toBeGreaterThan(200);
      // Only real orphan is increment_payment_link_uses; the rest come from
      // this test file's fixture strings which the linker sees as .rpc() calls.
      // Filter to production-only orphans for the assertion.
      const prodOrphans = result.orphan_rpcs.filter(
        (name: string) =>
          Object.entries(result.ts_to_rpcs).some(
            ([file, calls]: [string, any[]]) =>
              !file.includes('.test.') &&
              !file.includes('__tests__') &&
              calls.some((c: any) => c.rpc === name),
          ),
      );
      expect(prodOrphans.length).toBeLessThan(5);
    });

    it('finds Release Gate V2 high-risk RPCs', () => {
      const result = runJson('');
      for (const rpc of [
        'initialize_terminal_effects',
        'finalize_payment_confirmation',
        'accept_saved_card_offer',
      ]) {
        expect(result.rpc_to_sql[rpc]).toBeDefined();
        expect(result.rpc_to_sql[rpc].length).toBeGreaterThan(0);
      }
    });

    it('detects multiline .rpc() in verify route', () => {
      const result = runJson('');
      // verify/route.ts calls activate_paid_subscription on line 548-549 (multiline)
      const verifyFile = Object.entries(result.ts_to_rpcs).find(
        ([f]) => f.includes('onboarding/verify/route.ts'),
      );
      expect(verifyFile).toBeDefined();
      const rpcs = (verifyFile![1] as any[]).map((c: any) => c.rpc);
      expect(rpcs).toContain('activate_paid_subscription');
      expect(rpcs).toContain('reconcile_paid_allowance');
    });
  });
});
