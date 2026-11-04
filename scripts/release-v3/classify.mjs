// Release V3 lane classifier (RELEASE_GATE_V2.md §9.3). Fails closed.
//
// A change is STANDARD only if every changed file matches the explicit
// allowlist below AND no allowlisted code file's diff adds a server action,
// a non-display import, an environment read, or a network/storage call.
// Everything else is FULL. Changing this file is itself a full-lane change
// (scripts/** is not allowlisted). A reviewer may raise a lane, never lower it.
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
// Display-only code and static assets.
const CODE = /\.(tsx?|jsx?|mjs|cjs)$/;
const ASSET = /\.(png|jpe?g|gif|svg|webp|ico|avif|woff2?)$/;
const STANDARD_CODE_ROOTS = ['app/(marketing)/', 'components/marketing/', 'components/ui/'];
const STANDARD_ASSET_ROOTS = ['public/', ...STANDARD_CODE_ROOTS];
// Route handlers, middleware-like and config files are never display-only.
const NEVER_STANDARD = [/(^|\/)route\.(t|j)sx?$/, /(^|\/)(middleware|instrumentation)\.(t|j)s$/, /(^|\/)actions?\.(t|j)sx?$/,
  /(^|\/)(sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.(t|j)sx?$/];

// Import specifiers a display-only file may add. Anything else is full.
const SAFE_IMPORTS = [/^react(\/jsx-runtime)?$/, /^react-dom$/, /^next\/(link|image|font\/google|dynamic)$/, /^lucide-react$/,
  /^framer-motion$/, /^clsx$/, /^tailwind-merge$/, /^class-variance-authority$/,
  /^@\/components\/(ui|marketing)\/[A-Za-z0-9_./-]+$/, /^@\/lib\/utils$/];
// Added-line patterns that make an allowlisted file full.
const RISKY = [
  [/['"]use server['"]/, 'server action directive'],
  [/\bprocess\.env\b|\bimport\.meta\.env\b/, 'environment read'],
  [/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\baxios\b/, 'network call'],
  [/\b(localStorage|sessionStorage|indexedDB|caches)\b|document\.cookie|\bcookies\s*\(|\bheaders\s*\(/, 'storage or request-state access'],
  [/\.(from|rpc|storage|channel)\s*\(/, 'data client call'],
  [/\bdangerouslySetInnerHTML\b|\beval\s*\(|new\s+Function\s*\(|<script\b/i, 'raw HTML or script execution'],
  [/\bimport\s*\(\s*[^'"\s)]/, 'dynamic import with computed specifier'],
  [/\brequire\s*\(/, 'require call'],
];
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/g;

const matchesAny = (path, patterns) => patterns.some(p => p.test(path));
const under = (path, roots) => roots.some(root => path.startsWith(root));
export const isDocs = path => matchesAny(path, DOCS);
export const isGovernance = path => matchesAny(path, GOVERNANCE);

function importReasons(path, line) {
  const reasons = [];
  for (const match of line.matchAll(IMPORT)) {
    const spec = match[1];
    if (spec.startsWith('.')) {
      const resolved = posix.normalize(posix.join(posix.dirname(path), spec));
      if (!under(resolved, STANDARD_CODE_ROOTS)) reasons.push(`imports ${spec} (outside display-only paths)`);
    } else if (!matchesAny(spec, SAFE_IMPORTS)) reasons.push(`imports ${spec}`);
  }
  return reasons;
}

// changes: [{ path, status: 'A'|'M'|'D'|'T', added: string[] }] (added lines of the diff).
export function classifyChanges(changes, { raiseTo } = {}) {
  if (!Array.isArray(changes)) fail('Invalid change list');
  if (raiseTo !== undefined && raiseTo !== '' && raiseTo !== 'full') fail('A lane can only be raised to full, never lowered');
  const reasons = [];
  let docsOnly = changes.length > 0, governance = false;
  for (const change of changes) {
    const { path, status, added } = change || {};
    if (typeof path !== 'string' || !path || /[\r\n]/.test(path) || !['A', 'M', 'D', 'T'].includes(status) || !Array.isArray(added)) fail('Invalid change entry');
    if (isGovernance(path)) governance = true;
    if (isDocs(path) && !TOOLING_READ_DOCS.includes(path)) continue;
    docsOnly = false;
    if (isDocs(path)) { reasons.push(`${path}: read by CI, release or gate tooling`); continue; }
    if (matchesAny(path, NEVER_STANDARD)) { reasons.push(`${path}: not display-only`); continue; }
    if (ASSET.test(path) && under(path, STANDARD_ASSET_ROOTS)) {
      if (path.endsWith('.svg') && added.some(line => /<script\b|\son[a-z]+\s*=|javascript:/i.test(line))) reasons.push(`${path}: active SVG content`);
      continue;
    }
    if (!(CODE.test(path) && under(path, STANDARD_CODE_ROOTS))) { reasons.push(`${path}: not on the standard allowlist`); continue; }
    if (status === 'D') continue;
    if (status === 'T') { reasons.push(`${path}: file type change`); continue; }
    for (const line of added) {
      for (const [pattern, label] of RISKY) if (pattern.test(line)) reasons.push(`${path}: ${label}`);
      reasons.push(...importReasons(path, line).map(r => `${path}: ${r}`));
    }
  }
  if (!changes.length) reasons.push('no changes');
  if (raiseTo === 'full') reasons.push('raised to full by reviewer');
  const unique = [...new Set(reasons)].sort();
  const lane = unique.length ? 'full' : 'standard';
  return { lane, reasons: unique, docs_only: docsOnly, governance, required_reviews: lane === 'full' ? 2 : 1 };
}

// Reads the change list between two commits from git. Binary files carry no
// added lines; they are classified by path only.
export function collectChanges(repository, base, target) {
  if (!SHA.test(base) || !SHA.test(target)) fail('Exact commit SHAs required');
  const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: repository, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const status = git('diff', '--no-renames', '--name-status', '-z', base, target).split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < status.length; i += 2) {
    const code = status[i][0], path = status[i + 1];
    if (!['A', 'M', 'D', 'T'].includes(code) || !path) fail(`Unsupported change type ${status[i]}`);
    changes.push({ path, status: code, added: [] });
  }
  const byPath = new Map(changes.map(c => [c.path, c]));
  let current = null;
  const seen = new Set();
  for (const line of git('diff', '--no-renames', '--unified=0', '--no-color', '--no-ext-diff', base, target).split('\n')) {
    if (line.startsWith('+++ ')) {
      current = line === '+++ /dev/null' ? null : byPath.get(line.slice(6)) ?? null;
      if (line !== '+++ /dev/null' && !current) fail(`Unmatched diff header ${line}`);
      if (current) seen.add(current.path);
      continue;
    }
    if (line.startsWith('diff --git ')) { current = null; continue; }
    if (current && line.startsWith('+')) current.added.push(line.slice(1));
  }
  // A text file whose added lines could not be read must not pass the content
  // check by accident (binary assets carry no +++ header and are path-only).
  for (const change of changes) {
    if (change.status !== 'D' && (CODE.test(change.path) || change.path.endsWith('.svg')) && !seen.has(change.path)) fail(`Could not read the diff of ${change.path}`);
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, target] = process.argv.slice(2);
  const result = classifyChanges(collectChanges(process.cwd(), base, target));
  console.log(JSON.stringify(result, null, 1));
}
