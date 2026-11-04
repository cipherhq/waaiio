/**
 * Per-PR changelog fragments: scripts/changelog/collect.mjs.
 * Runs the real script functions against a temporary repo layout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs module without types
import { readFragments, orderFragments, buildChangelog, run } from '../changelog/collect.mjs';

let root: string;
const dir = () => join(root, 'changelog', 'unreleased');
const frag = (name: string, text: string) => writeFileSync(join(dir(), name), text);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'changelog-test-'));
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), '.gitkeep'), '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('check', () => {
  it('passes with no fragments and ignores .gitkeep / README.md', () => {
    writeFileSync(join(dir(), 'README.md'), 'not a fragment');
    expect(run(root, ['check'])).toBe(0);
  });

  it('passes for a well-formed fragment', () => {
    frag('2026-11-04-calendar-fix.md', '## 2026-11-04 — Calendar fix\n\n- Did a thing.\n');
    expect(readFragments(root)).toMatchObject({ errors: [], fragments: [{ file: '2026-11-04-calendar-fix.md', date: '2026-11-04' }] });
    expect(run(root, ['check'])).toBe(0);
  });

  it.each([
    ['bad name', 'calendar-fix.md', '## 2026-11-04 — X\n\n- y', /name must be/],
    ['uppercase slug', '2026-11-04-Calendar.md', '## 2026-11-04 — X\n\n- y', /name must be/],
    ['impossible date', '2026-02-30-x.md', '## 2026-02-30 — X\n\n- y', /not a real date/],
    ['missing heading', '2026-11-04-x.md', '- just a bullet', /first line must be/],
    ['hyphen instead of em dash', '2026-11-04-x.md', '## 2026-11-04 - X\n\n- y', /first line must be/],
    ['date mismatch', '2026-11-04-x.md', '## 2026-11-03 — X\n\n- y', /does not match/],
    ['heading only', '2026-11-04-x.md', '## 2026-11-04 — X\n\n', /no entry text/],
  ])('fails for %s', (_label, name, text, msg) => {
    frag(name, text);
    const { errors } = readFragments(root);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(msg);
    expect(run(root, ['check'])).toBe(1);
  });
});

describe('collect', () => {
  it('prepends fragments newest first, keeps the old changelog, and deletes the fragments', () => {
    writeFileSync(join(root, 'CHANGELOG.md'), '## 2026-11-01 — Old entry\n\n- old\n');
    frag('2026-11-03-a.md', '## 2026-11-03 — A\n\n- a');
    frag('2026-11-04-b.md', '## 2026-11-04 — B\n\n- b');
    frag('2026-11-04-c.md', '## 2026-11-04 — C\n\n- c');
    expect(run(root, ['collect'])).toBe(0);
    const out = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(out).toBe('## 2026-11-04 — C\n\n- c\n\n## 2026-11-04 — B\n\n- b\n\n## 2026-11-03 — A\n\n- a\n\n## 2026-11-01 — Old entry\n\n- old\n');
    expect(readdirSync(dir())).toEqual(['.gitkeep']);
  });

  it('dry run changes nothing', () => {
    writeFileSync(join(root, 'CHANGELOG.md'), '## 2026-11-01 — Old\n\n- old\n');
    frag('2026-11-04-b.md', '## 2026-11-04 — B\n\n- b');
    expect(run(root, ['collect', '--dry-run'])).toBe(0);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe('## 2026-11-01 — Old\n\n- old\n');
    expect(existsSync(join(dir(), '2026-11-04-b.md'))).toBe(true);
  });

  it('refuses to collect when any fragment is malformed, and changes nothing', () => {
    writeFileSync(join(root, 'CHANGELOG.md'), 'old\n');
    frag('2026-11-04-good.md', '## 2026-11-04 — Good\n\n- g');
    frag('bad.md', 'nope');
    expect(run(root, ['collect'])).toBe(1);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe('old\n');
    expect(existsSync(join(dir(), '2026-11-04-good.md'))).toBe(true);
  });

  it('with no fragments leaves CHANGELOG.md untouched', () => {
    writeFileSync(join(root, 'CHANGELOG.md'), 'old\n');
    expect(run(root, ['collect'])).toBe(0);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe('old\n');
  });

  it('works when CHANGELOG.md does not exist yet', () => {
    frag('2026-11-04-b.md', '## 2026-11-04 — B\n\n- b');
    expect(run(root, ['collect'])).toBe(0);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe('## 2026-11-04 — B\n\n- b\n');
  });
});

describe('helpers', () => {
  it('orders by date then file name, newest first', () => {
    const order = orderFragments([
      { file: '2026-11-03-z.md', date: '2026-11-03', text: '' },
      { file: '2026-11-04-a.md', date: '2026-11-04', text: '' },
      { file: '2026-11-04-b.md', date: '2026-11-04', text: '' },
    ]).map((f: { file: string }) => f.file);
    expect(order).toEqual(['2026-11-04-b.md', '2026-11-04-a.md', '2026-11-03-z.md']);
  });

  it('buildChangelog trims leading blank lines from the old file', () => {
    expect(buildChangelog('\n\nold\n', [{ file: '2026-11-04-a.md', date: '2026-11-04', text: '## 2026-11-04 — A\n\n- a' }])).toBe('## 2026-11-04 — A\n\n- a\n\nold\n');
  });

  it('a unknown command returns 2', () => {
    expect(run(root, ['nope'])).toBe(2);
  });
});
