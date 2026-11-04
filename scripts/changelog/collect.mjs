#!/usr/bin/env node
/**
 * Per-PR changelog fragments (Owner decision 2026-11-04).
 *
 * Each PR adds one file to changelog/unreleased/ instead of editing the top of
 * CHANGELOG.md, so PRs no longer conflict with each other on the changelog
 * (every conflict invalidated exact-head review approvals).
 *
 *   node scripts/changelog/collect.mjs check     validate fragments (CI)
 *   node scripts/changelog/collect.mjs collect   prepend fragments to CHANGELOG.md
 *                                                (newest first) and delete them
 *   node scripts/changelog/collect.mjs collect --dry-run   print, change nothing
 *
 * Fragment rules:
 *   - file name: YYYY-MM-DD-<slug>.md, slug = the branch name with '/' as '-'
 *     (lowercase letters, digits, '-'), so two PRs never pick the same file
 *   - a regular file (not a symlink or folder); dotfiles such as .DS_Store are ignored
 *   - first line: "## YYYY-MM-DD — <title>" with the same date as the file name
 *   - at least one non-empty line after the heading
 */
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, lstatSync, renameSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FRAGMENT_NAME = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const HEADING = /^## (\d{4}-\d{2}-\d{2}) — \S.*$/;
const IGNORED = new Set(['README.md']);

function isRealDate(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

/** Returns { fragments: [{ file, date, text }], errors: string[] } for a repo root. */
export function readFragments(root) {
  const dir = join(root, 'changelog', 'unreleased');
  const errors = [];
  const fragments = [];
  if (!existsSync(dir)) return { fragments, errors };
  for (const file of readdirSync(dir).sort()) {
    if (IGNORED.has(file) || file.startsWith('.')) continue;
    if (!lstatSync(join(dir, file)).isFile()) {
      errors.push(`${file}: must be a regular file (not a folder or symlink)`);
      continue;
    }
    const m = FRAGMENT_NAME.exec(file);
    if (!m) {
      errors.push(`${file}: name must be YYYY-MM-DD-<slug>.md (lowercase letters, digits, '-')`);
      continue;
    }
    const date = m[1];
    if (!isRealDate(date)) {
      errors.push(`${file}: ${date} is not a real date`);
      continue;
    }
    const text = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim();
    const [first, ...rest] = text.split('\n');
    const h = HEADING.exec(first ?? '');
    if (!h) {
      errors.push(`${file}: first line must be "## ${date} — <title>"`);
      continue;
    }
    if (h[1] !== date) {
      errors.push(`${file}: heading date ${h[1]} does not match file name date ${date}`);
      continue;
    }
    if (!rest.some((line) => line.trim() !== '')) {
      errors.push(`${file}: has a heading but no entry text`);
      continue;
    }
    fragments.push({ file, date, text });
  }
  return { fragments, errors };
}

/** By fragment date, newest first; on the same date, by file name (descending). */
export function orderFragments(fragments) {
  return [...fragments].sort((a, b) => (a.date === b.date ? b.file.localeCompare(a.file) : b.date.localeCompare(a.date)));
}

/** The new CHANGELOG.md text with fragments prepended. */
export function buildChangelog(existing, fragments) {
  const head = orderFragments(fragments).map((f) => f.text).join('\n\n');
  const rest = existing.replace(/^\s+/, '');
  return rest ? `${head}\n\n${rest}` : `${head}\n`;
}

export function run(root, args) {
  const [cmd, ...flags] = args;
  const { fragments, errors } = readFragments(root);
  if (cmd === 'check') {
    if (errors.length) {
      for (const e of errors) console.error(`changelog fragment error: ${e}`);
      return 1;
    }
    console.log(`changelog fragments OK (${fragments.length})`);
    return 0;
  }
  if (cmd === 'collect') {
    if (errors.length) {
      for (const e of errors) console.error(`changelog fragment error: ${e}`);
      return 1;
    }
    if (!fragments.length) {
      console.log('No changelog fragments to collect.');
      return 0;
    }
    const path = join(root, 'CHANGELOG.md');
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const next = buildChangelog(existing, fragments);
    if (flags.includes('--dry-run')) {
      console.log(next.slice(0, next.length - existing.replace(/^\s+/, '').length));
      return 0;
    }
    // Write the new changelog atomically, then delete the fragments it now holds.
    // If a delete fails, recover with: git checkout -- CHANGELOG.md changelog/
    const tmp = `${path}.collect-tmp`;
    writeFileSync(tmp, next);
    renameSync(tmp, path);
    for (const f of fragments) unlinkSync(join(root, 'changelog', 'unreleased', f.file));
    console.log(`Collected ${fragments.length} fragment(s) into CHANGELOG.md`);
    return 0;
  }
  console.error('Usage: node scripts/changelog/collect.mjs <check|collect> [--dry-run]');
  return 2;
}

// Compare as file URLs of the real path, so a path with spaces, unicode or a
// symlink still runs the CLI (a mismatch would silently skip the check).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(run(process.cwd(), process.argv.slice(2)));
}
