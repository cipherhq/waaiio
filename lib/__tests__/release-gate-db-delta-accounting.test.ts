import { beforeEach, describe, expect, it, vi } from 'vitest';

const processMocks = vi.hoisted(() => ({ execSync: vi.fn(), execFileSync: vi.fn() }));
vi.mock('child_process', () => processMocks);
import { applyBaseMigrations, applyCandidateMigrations } from '../release-gate/db-delta-cli';

const installer = '501_accounting_cutover_installer.sql';
const dbUrl = 'postgresql://postgres@localhost:55490/disposable_delta';

describe('DB delta approved accounting replay', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    processMocks.execSync.mockImplementation((command: string) =>
      command.startsWith('git show ') ? `exact blob: ${command}` : '');
  });

  it.each(['base', 'candidate'] as const)('%s replay restores only exact M501 after applying its SHA blob', phase => {
    const files = ['500_accounting_hold_preparation.sql', installer, '502_next.sql'];
    const apply = phase === 'base' ? applyBaseMigrations : applyCandidateMigrations;
    const paths = phase === 'base' ? files.map(file => `supabase/migrations/${file}`) : files;
    expect(apply(dbUrl, `${phase}-sha`, paths)).toBe(3);
    const exactBlob = `exact blob: git show "${phase}-sha:supabase/migrations/${installer}"`;
    const sqlCall = processMocks.execSync.mock.calls.findIndex(([, options]) => options?.input === exactBlob);
    expect(sqlCall).toBeGreaterThanOrEqual(0);
    expect(processMocks.execFileSync).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      [expect.stringMatching(/scripts\/ci-restore-accounting-entrypoints\.mjs$/), dbUrl, '--migration-stdin'],
      { input: exactBlob, encoding: 'utf-8', timeout: 60000 },
    );
    expect(processMocks.execSync.mock.invocationCallOrder[sqlCall]).toBeLessThan(
      processMocks.execFileSync.mock.invocationCallOrder[0]);
    expect(processMocks.execFileSync.mock.invocationCallOrder[0]).toBeLessThan(
      processMocks.execSync.mock.invocationCallOrder[sqlCall + 1]);
  });

  it('does not match a different migration with a similar prefix', () => {
    applyCandidateMigrations(dbUrl, 'head', ['501_other.sql', '1501_accounting_cutover_installer.sql']);
    expect(processMocks.execFileSync).not.toHaveBeenCalled();
  });

  it('does not restore after migration application fails', () => {
    processMocks.execSync.mockImplementation((command: string) => {
      if (command.startsWith('psql ')) throw new Error('migration rejected');
      return 'exact rejected blob';
    });
    expect(() => applyBaseMigrations(dbUrl, 'base', [`supabase/migrations/${installer}`])).toThrow('Migration application failed');
    expect(processMocks.execFileSync).not.toHaveBeenCalled();
  });

  it('does not continue replay after restoration fails a guard or catalog lock', () => {
    processMocks.execFileSync.mockImplementation(() => { throw new Error('approved lock mismatch'); });
    expect(() => applyCandidateMigrations(dbUrl, 'head', [installer, '502_next.sql'])).toThrow('approved lock mismatch');
    expect(processMocks.execSync.mock.calls.some(([command]) => command.includes('502_next.sql'))).toBe(false);
  });
});
