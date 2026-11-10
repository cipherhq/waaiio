/**
 * Release V3 oracle: after replaying M501, the oracle installs the accounting
 * installer's recurring-finalizer bodies (as the Owner-approved packet did on
 * production and staging) and requires them to equal both approved locks.
 * The replay itself runs in the "Catalog oracle (PostgreSQL 17)" CI job; these
 * tests cover the extraction and the fail-closed lock comparison.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  ACCOUNTING_INSTALLED, accountingInstallerStatement, installAccountingFinalizers, CATALOG_QUERY,
} from '../release-v3/catalog-oracle.mjs';

const m501 = readFileSync('supabase/migrations/501_accounting_cutover_installer.sql', 'utf8');
const lock = (env: string) => JSON.parse(readFileSync(`scripts/release-v3/lock-catalog-${env}.json`, 'utf8')).objects;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

describe('M501 installer extraction', () => {
  it('returns exactly one CREATE for each listed finalizer', () => {
    for (const { tag, identity } of ACCOUNTING_INSTALLED) {
      const sql = accountingInstallerStatement(m501, tag);
      const name = identity.slice('function:public.'.length, identity.indexOf('('));
      expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${name}(`);
      expect(sql).not.toContain(`$${tag}$`);
    }
  });

  it('fails closed when a block is missing, repeated or unclosed', () => {
    const tag = ACCOUNTING_INSTALLED[0].tag;
    expect(() => accountingInstallerStatement('SELECT 1;', tag)).toThrow(/not present exactly once/);
    const block = `EXECUTE $${tag}$ SELECT 1; $${tag}$;`;
    expect(() => accountingInstallerStatement(block + block, tag)).toThrow(/not present exactly once/);
    expect(() => accountingInstallerStatement(`EXECUTE $${tag}$ SELECT 1;`, tag)).toThrow(/not closed exactly once/);
  });

  it('both approved locks record the listed finalizers, with the same digest', () => {
    for (const { identity } of ACCOUNTING_INSTALLED) {
      expect(lock('production')[identity]).toMatch(/^[a-f0-9]{64}$/);
      expect(lock('staging')[identity]).toBe(lock('production')[identity]);
    }
  });
});

describe('installAccountingFinalizers', () => {
  const fakeClient = (digests: Record<string, string>) => {
    const queries: string[] = [];
    return {
      queries,
      async query(sql: string) {
        queries.push(sql);
        if (sql !== CATALOG_QUERY) return { rows: [] };
        return { rows: Object.entries(digests).map(([identity, d]) => ({ identity, digest: d, value: {} })) };
      },
    };
  };
  const matching = () => Object.fromEntries(ACCOUNTING_INSTALLED.map(({ identity }) => [identity, lock('production')[identity]]));

  it('runs each installer block, then reads the catalog, and passes when it equals both locks', async () => {
    const client = fakeClient(matching());
    await installAccountingFinalizers(client, m501);
    expect(client.queries).toHaveLength(ACCOUNTING_INSTALLED.length + 1);
    ACCOUNTING_INSTALLED.forEach(({ tag }, i) => expect(client.queries[i]).toBe(accountingInstallerStatement(m501, tag)));
    expect(client.queries.at(-1)).toBe(CATALOG_QUERY);
  });

  it('fails when an installed body differs from the approved lock', async () => {
    const digests = matching();
    digests[ACCOUNTING_INSTALLED[1].identity] = digest('different body');
    await expect(installAccountingFinalizers(fakeClient(digests), m501)).rejects.toThrow(/does not equal the approved lock/);
  });

  it('fails when a lock does not record the object', async () => {
    const locks = [lock('production'), {}];
    await expect(installAccountingFinalizers(fakeClient(matching()), m501, locks)).rejects.toThrow(/does not equal the approved lock/);
  });
});
