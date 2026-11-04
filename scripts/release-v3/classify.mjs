// Release V3 lane classifier (RELEASE_GATE_V2.md §9.3). Fails closed.
//
// A change is STANDARD only if every changed file matches the explicit
// allowlist below and every allowlisted code file is display-only:
//  - both its before and after versions are scanned in full (not just the
//    added lines), so editing an existing data-access file is full;
//  - every import resolves to a safe package or to a repository module that is
//    itself display-only (checked recursively at the target);
//  - no server action, environment, network, storage, data-client, raw HTML or
//    computed import appears anywhere in the file.
// Payment-named paths, symlinks and submodules are always full. Everything
// else is FULL. Changing this file is itself a full-lane change (scripts/** is
// not allowlisted). A reviewer may raise a lane, never lower it.
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, SHA } from './common.mjs';

export const LANES = Object.freeze(['standard', 'full']);

// Docs are not deployed code. They are standard for release purposes and need
// one review (§9.3); governance and agent-instruction files also need CTO review.
// A file is docs-only only if it is Markdown under docs/ or at the root, matches
// no full-lane path, and no CI, release or gate tooling reads it. When classes
// overlap, the stricter class wins (it is then classified as code: full).
const DOCS = [/^docs\/(?!contracts\/).+\.md$/, /^[^/]+\.md$/];
// Markdown that tooling reads (scripts/verify-engineering-governance.mjs,
// scripts/reduced-payout-policy.mjs). A test fails if tooling source names a
// docs/*.md or root *.md path that is missing here.
export const TOOLING_READ_DOCS = Object.freeze(['docs/CHAT_HANDOFF_TEMPLATE.md', 'docs/ENGINEERING_STATUS.md', 'docs/ENGINEERING_WORKFLOW.md', 'docs/MIGRATION_REGISTRY.md']);
const GOVERNANCE = [/^CLAUDE\.md$/, /^WAAIIO_ENGINEERING_OPERATING_ORDER\.md$/, /^RELEASE_GATE_V2\.md$/,
  /^docs\/MERCHANT_PAYMENT_CUSTODY_POLICY\.md$/, /^docs\/contracts\//, /^\.agents\//, /^\.claude\//];
// Payment-safety paths (§9.1.2): never standard, whatever folder they are in.
const PAYMENT_PATH = /payment|payout|(^|[^a-z])fees?([^a-z]|$)|refund|webhook|settle|billing|checkout|stripe|paystack|flutterwave|square|paypal|invoice|subscription|wallet|transfer/i;
// camelCase is split first, so `PricingFees.tsx` matches as `Pricing-Fees.tsx`.
export const isPaymentPath = path => PAYMENT_PATH.test(path.replace(/([a-z0-9])([A-Z])/g, '$1-$2'));
const CODE = /\.(tsx?|jsx?|mjs|cjs)$/;
const ASSET = /\.(png|jpe?g|gif|svg|webp|ico|avif|woff2?)$/;
const STANDARD_CODE_ROOTS = ['app/(marketing)/', 'components/marketing/', 'components/ui/'];
const STANDARD_ASSET_ROOTS = ['public/', ...STANDARD_CODE_ROOTS];
// Repository modules a display-only file may import (if they are display-only too).
const IMPORTABLE_ROOTS = ['components/marketing/', 'components/ui/'];
const IMPORTABLE_FILES = ['lib/utils.ts'];
// Route handlers, middleware-like and metadata files are never display-only.
const NEVER_STANDARD = [/(^|\/)route\.(t|j)sx?$/, /(^|\/)(middleware|instrumentation)\.(t|j)s$/, /(^|\/)actions?\.(t|j)sx?$/,
  /(^|\/)(sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.(t|j)sx?$/];
// Packages a display-only file may import.
const SAFE_PACKAGES = [/^react(\/jsx-runtime)?$/, /^react-dom$/, /^next\/(link|image|font\/google|dynamic)$/, /^lucide-react$/,
  /^framer-motion$/, /^clsx$/, /^tailwind-merge$/, /^class-variance-authority$/];
// Any match anywhere in the raw file text (comments included) makes it full.
const RISKY = [
  [/['"]use server['"]/, 'server action directive'],
  [/\bprocess\s*(\?\.\s*)?(\.\s*[A-Za-z_$]|\[)|[=(,]\s*process\s*[;),\]\n]|\}\s*=\s*process\b|\bimport\s*\.\s*meta\b|\bglobalThis\b/, 'environment or global access'],
  [/\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\baxios\b/, 'network call'],
  [/\b(localStorage|sessionStorage|indexedDB|caches)\b|\bdocument\s*\.\s*cookie|\bcookies\s*\(|\bheaders\s*\(/, 'storage or request-state access'],
  [/\.\s*(from|rpc)\s*\(\s*['"`]|\.\s*storage\b|\.\s*channel\s*\(|\bcreate(Service|Server|Browser)?Client\b|\bsupabase\b/i, 'data client access'],
  [/\bdangerouslySetInnerHTML\b|\beval\b|\bFunction\s*\(|<script\b|\bsrcdoc\b/i, 'raw HTML or script execution'],
  [/\b(window|self|top|parent|frames|globalThis|document)\s*(\?\.\s*)?\[|\batob\b|\bReflect\b|\bProxy\b/, 'computed global access'],
  [/\brequire\s*\(/, 'require call'],
];
const SPACE = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
// Specifiers after `from` / `import` / `import(`, allowing comments and line breaks.
const SPECIFIER = new RegExp(String.raw`\b(?:from|import)${SPACE}(?:\(${SPACE})?(['"])([^'"\n]*)\1`, 'g');
// Every `import(` must be a literal-specifier dynamic import.
const DYNAMIC = new RegExp(String.raw`\bimport${SPACE}\(`, 'g');
const DYNAMIC_LITERAL = new RegExp(String.raw`\bimport${SPACE}\(${SPACE}['"][^'"\n]*['"]${SPACE}\)`, 'g');


// `import type X from` / `export type { A, B } from` are erased at compile
// time. Strict: the text between the nearest import/export keyword and `from`
// must be exactly a type clause (names only, no comments). Anything else is
// treated as a runtime import and checked.
const TYPE_CLAUSE = /^\s+type\s+(\{[\s\w$,]*\}|[A-Za-z_$][\w$]*|\*\s+as\s+[A-Za-z_$][\w$]*)\s+$/;
// Blanks comments to spaces (same length, newlines kept) so a keyword written
// inside a comment is never taken as the statement keyword. A wrong mask can
// only make an import look like a runtime import (stricter), never type-only.
export function maskComments(text) {
  const out = text.split('');
  let i = 0, quote = null;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (quote) { if (c === '\\') i += 2; else { if (c === quote) quote = null; i++; } continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') out[i++] = ' '; continue; }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2), stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== '\n') out[i] = ' ';
      continue;
    }
    i++;
  }
  return out.join('');
}
function isTypeOnly(text, fromIndex, masked) {
  if (!/^from\b/.test(text.slice(fromIndex))) return false;
  const start = Math.max(0, fromIndex - 2000);
  const keywords = [...masked.slice(start, fromIndex).matchAll(/\b(import|export)\b/g)];
  if (!keywords.length) return false;
  const last = keywords.at(-1);
  // The RAW clause must be exactly a type clause: any comment inside it fails.
  return TYPE_CLAUSE.test(text.slice(start + last.index + last[0].length, fromIndex));
}

const matchesAny = (path, patterns) => patterns.some(p => p.test(path));
const under = (path, roots) => roots.some(root => path.startsWith(root));
export const isDocs = path => matchesAny(path, DOCS);
export const isGovernance = path => matchesAny(path, GOVERNANCE);

// Resolves an alias or relative specifier to a repository path, or null.
// `..` segments in an alias, or a path that leaves the repository, are rejected.
export function resolveSpecifier(fromPath, spec) {
  let path;
  if (spec.startsWith('@/')) {
    path = spec.slice(2);
    if (path.split('/').some(s => s === '..' || s === '.' || s === '')) return null;
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    path = posix.normalize(posix.join(posix.dirname(fromPath), spec));
    if (path.startsWith('../') || path.startsWith('/')) return null;
  } else return null;
  return path;
}
const CANDIDATES = p => [p, ...['.tsx', '.ts', '.jsx', '.js'].map(e => p + e), ...['/index.tsx', '/index.ts'].map(e => p + e)];

// Scans one file's full text. `readTarget(path)` returns a repository file's
// text at the target (or null); imported modules are scanned recursively.
export function scanText(path, text, readTarget, seen = new Set()) {
  const reasons = [];
  for (const [pattern, label] of RISKY) if (pattern.test(text)) reasons.push(`${path}: ${label}`);
  const dynamic = (text.match(DYNAMIC) || []).length, literal = (text.match(DYNAMIC_LITERAL) || []).length;
  if (dynamic !== literal) reasons.push(`${path}: dynamic import with computed specifier`);
  const masked = maskComments(text);
  for (const match of text.matchAll(SPECIFIER)) {
    const spec = match[2];
    if (matchesAny(spec, SAFE_PACKAGES) || isTypeOnly(text, match.index, masked)) continue;
    const resolved = resolveSpecifier(path, spec);
    if (!resolved || !(under(resolved, IMPORTABLE_ROOTS) || under(resolved, STANDARD_CODE_ROOTS) || CANDIDATES(resolved).some(c => IMPORTABLE_FILES.includes(c)))) {
      reasons.push(`${path}: imports ${spec}`); continue;
    }
    const file = CANDIDATES(resolved).find(c => readTarget?.(c) != null);
    if (!file) { reasons.push(`${path}: imports ${spec} (cannot be resolved at the target)`); continue; }
    if (matchesAny(file, NEVER_STANDARD) || isPaymentPath(file)) { reasons.push(`${path}: imports ${file} (not display-only)`); continue; }
    if (seen.has(file)) continue;
    seen.add(file);
    if (seen.size > 300) { reasons.push(`${path}: import graph too large to verify`); break; }
    reasons.push(...scanText(file, readTarget(file), readTarget, seen).map(r => `${path} → ${r}`));
  }
  return reasons;
}

// changes: [{ path, status: 'A'|'M'|'D'|'T', modes: [before, after], texts: string[] }]
// texts are the full before/after contents of code and SVG files.
export function classifyChanges(changes, { raiseTo, readTarget = () => null } = {}) {
  if (!Array.isArray(changes)) fail('Invalid change list');
  if (raiseTo !== undefined && raiseTo !== '' && raiseTo !== 'full') fail('A lane can only be raised to full, never lowered');
  const reasons = [];
  let docsOnly = changes.length > 0, governance = false;
  for (const change of changes) {
    const { path, status, modes = ['100644', '100644'], texts } = change || {};
    if (typeof path !== 'string' || !path || /[\r\n]/.test(path) || !['A', 'M', 'D', 'T'].includes(status) || !Array.isArray(texts)
      || texts.some(t => typeof t !== 'string') || !Array.isArray(modes)) fail('Invalid change entry');
    if (isGovernance(path)) governance = true;
    if (modes.some(m => m === '120000' || m === '160000')) { docsOnly = false; reasons.push(`${path}: symlink or submodule`); continue; }
    if (isDocs(path) && !TOOLING_READ_DOCS.includes(path)) continue;
    docsOnly = false;
    if (isDocs(path)) { reasons.push(`${path}: read by CI, release or gate tooling`); continue; }
    if (isPaymentPath(path)) { reasons.push(`${path}: payment path`); continue; }
    if (matchesAny(path, NEVER_STANDARD)) { reasons.push(`${path}: not display-only`); continue; }
    if (ASSET.test(path) && under(path, STANDARD_ASSET_ROOTS)) {
      if (path.endsWith('.svg') && texts.some(t => /<script\b|\son[a-z]+\s*=|javascript:|<foreignObject\b/i.test(t))) reasons.push(`${path}: active SVG content`);
      continue;
    }
    if (!(CODE.test(path) && under(path, STANDARD_CODE_ROOTS))) { reasons.push(`${path}: not on the standard allowlist`); continue; }
    if (status === 'T') { reasons.push(`${path}: file type change`); continue; }
    if (texts.length !== (status === 'M' ? 2 : 1)) fail(`Missing file contents for ${path}`);
    for (const text of texts) reasons.push(...scanText(path, text, readTarget));
  }
  if (!changes.length) reasons.push('no changes');
  if (raiseTo === 'full') reasons.push('raised to full by reviewer');
  const unique = [...new Set(reasons)].sort();
  const lane = unique.length ? 'full' : 'standard';
  return { lane, reasons: unique, docs_only: docsOnly, governance, required_reviews: lane === 'full' ? 2 : 1 };
}

// Reads the change list between two commits from git, with file modes and the
// full before/after text of every code and SVG file.
export function collectChanges(repository, base, target) {
  if (!SHA.test(base) || !SHA.test(target)) fail('Exact commit SHAs required');
  const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: repository, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const raw = git('diff', '--raw', '--no-renames', '--no-abbrev', '-z', base, target).split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < raw.length; i += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40} [0-9a-f]{40} ([AMDT])$/.exec(raw[i]);
    const path = raw[i + 1];
    if (!match || !path) fail(`Unsupported change ${raw[i]}`);
    const [, before, after, status] = match;
    const texts = [];
    if (CODE.test(path) || path.endsWith('.svg')) {
      if (status !== 'A') texts.push(git('show', `${base}:${path}`));
      if (status !== 'D') texts.push(git('show', `${target}:${path}`));
    }
    changes.push({ path, status, modes: [before, after], texts });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// A file's text at `revision`, or null if it does not exist there.
export function targetReader(repository, revision) {
  const cache = new Map();
  return path => {
    if (!cache.has(path)) {
      try { cache.set(path, execFileSync('git', ['show', `${revision}:${path}`], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })); }
      catch { cache.set(path, null); }
    }
    return cache.get(path);
  };
}

export const classifyRange = (repository, base, target, options = {}) =>
  classifyChanges(collectChanges(repository, base, target), { ...options, readTarget: targetReader(repository, target) });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, target] = process.argv.slice(2);
  console.log(JSON.stringify(classifyRange(process.cwd(), base, target), null, 1));
}
