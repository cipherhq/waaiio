import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { classifyChanges, collectChanges, classifyRange, resolveSpecifier, TOOLING_READ_DOCS } from '../release-v3/classify.mjs';

// Repository files visible at the target for import resolution.
const REPO: Record<string, string> = {
  'lib/utils.ts': "export const cn = (...a: string[]) => a.join(' ');",
  'components/ui/Badge.tsx': "import { cn } from '@/lib/utils';\nexport const Badge = () => <span className={cn('a')} />;",
  'components/ui/Fetcher.tsx': "export async function load() { return (await fetch('/api/x')).json(); }",
  'components/ui/Inner.tsx': "import { load } from './Fetcher';\nexport const Inner = () => null;",
};
const readTarget = (p: string) => REPO[p] ?? null;
type Change = { path: string; status: string; texts: string[]; modes?: string[] };
const change = (path: string, text = 'export const x = 1;', status = 'M', before = 'export const x = 0;'): Change => ({ path, status,
  texts: /\.(tsx?|jsx?|mjs|cjs|svg)$/.test(path) ? (status === 'M' ? [before, text] : [text]) : [] });
const lane = (...changes: Change[]) => classifyChanges(changes, { readTarget });

describe('Release V3 lane classifier: path', () => {
  it('standard: display-only marketing, ui and static assets, with imports that resolve to display-only modules', () => {
    const r = lane(change('app/(marketing)/about/page.tsx', "import Link from 'next/link';\nimport type { Metadata } from 'next';\nexport default function About() { return <Link href=\"/x\">We process your data.</Link>; }"),
      change('components/ui/Badge.tsx', REPO['components/ui/Badge.tsx']), change('public/logo.png'), change('components/marketing/Hero.tsx', "import { Badge } from '../ui/Badge';"));
    expect(r).toMatchObject({ lane: 'standard', reasons: [], required_reviews: 1 });
  });
  it.each(['scripts/new-thing.mjs', 'lib/url.ts', 'app/dashboard/page.tsx', 'tsconfig.json', 'some/unknown/file.xyz'])(
    'unknown or non-allowlisted path %s routes to full', path => expect(lane(change(path))).toMatchObject({ lane: 'full', required_reviews: 2 }));
  it.each([
    'lib/payments/stripe.ts', 'app/api/webhooks/paystack/route.ts', 'app/api/payouts/route.ts', 'lib/payouts/accounting-hold.ts',
    'app/dashboard/payouts/page.tsx', 'admin/src/pages/Payouts.tsx', 'lib/bot/bot.service.ts', 'supabase/functions/x/index.ts',
  ])('payment, provider, bot or admin path %s routes to full', path => expect(lane(change(path)).lane).toBe('full'));
  it.each(['components/ui/CheckoutButton.tsx', 'components/marketing/PricingFees.tsx', 'app/(marketing)/refund-policy/page.tsx', 'public/stripe-badge.svg'])(
    'a payment-named file is full even inside a display-only folder: %s', path => expect(lane(change(path)).reasons).toContain(`${path}: payment path`));
  it.each([
    'supabase/migrations/509_x.sql', '.github/workflows/ci.yml', 'package.json', 'package-lock.json', 'middleware.ts', 'next.config.js', 'vercel.json',
    'lib/supabase/client.ts', 'app/auth/callback/route.ts', 'scripts/release-v3/classify.mjs', 'supabase/catalog-deltas/509_x.json',
  ])('§9.3 always-full path %s routes to full', path => expect(lane(change(path)).lane).toBe('full'));
  it.each(['app/(marketing)/pricing/route.ts', 'app/(marketing)/actions.ts', 'app/(marketing)/sitemap.ts', 'components/ui/middleware.ts'])(
    'route handlers, actions and metadata files inside allowlisted folders are full: %s', path => expect(lane(change(path)).lane).toBe('full'));
  it('a binary or text asset outside the asset roots is full', () => expect(lane(change('lib/logo.png')).lane).toBe('full'));
  it('a symlink or submodule is full', () => {
    expect(lane({ ...change('components/ui/Link.tsx'), modes: ['000000', '120000'] }).reasons).toEqual(['components/ui/Link.tsx: symlink or submodule']);
    expect(lane({ path: 'components/ui/vendor', status: 'A', texts: [], modes: ['000000', '160000'] }).lane).toBe('full');
  });
});

describe('Release V3 lane classifier: content (whole before and after versions)', () => {
  const page = 'app/(marketing)/pricing/page.tsx';
  it.each([
    ["'use server';", 'server action directive'],
    ["import { createClient } from '@/lib/supabase/client';", 'data client access'],
    ["import Stripe from 'stripe';", 'imports stripe'],
    ["import { send } from '@/lib/bot/bot.service';", 'imports @/lib/bot/bot.service'],
    ["import { x } from '../../../lib/payments/factory';", 'imports ../../../lib/payments/factory'],
    ['const k = process.env.NEXT_PUBLIC_X;', 'environment or global access'],
    ["const k = process['env'];", 'environment or global access'],
    ['const { env } = process;', 'environment or global access'],
    ["await fetch('/api/pricing');", 'network call'],
    ["localStorage.setItem('a', 'b');", 'storage or request-state access'],
    ["client.from('payments').select();", 'data client access'],
    ['<div dangerouslySetInnerHTML={{ __html: x }} />', 'raw HTML or script execution'],
    ['const m = await import(name);', 'dynamic import with computed specifier'],
    ["const fs = require('fs');", 'require call'],
    // Reviewer bypasses (PR #848, review 1).
    ["import x from '@/components/ui/../../lib/supabase/service';", 'data client access'],
    ["import { a } from /* comment */ 'stripe';", 'imports stripe'],
    ["import {\n  a,\n} from\n  'stripe';", 'imports stripe'],
    ["export * from 'stripe';", 'imports stripe'],
    ["import { Inner } from '@/components/ui/Inner';", 'components/ui/Fetcher.tsx: network call'],
    ["import { Gone } from '@/components/ui/Missing';", 'cannot be resolved at the target'],
  ])('an allowlisted file containing %j is full', (text, reason) => {
    const r = lane(change(page, text, 'A'));
    expect(r.lane).toBe('full');
    expect(r.reasons.join('\n')).toContain(reason);
  });
  it('REGRESSION: editing an existing data-access file is full even if the edit itself adds nothing risky', () => {
    const before = "import { createServiceClient } from '@/lib/supabase/service';\nexport default async function Page() { const s = createServiceClient(); return s.from('businesses').select('name'); }";
    const after = before.replace("select('name')", "select('*')");
    const r = lane(change('app/(marketing)/directory/page.tsx', after, 'M', before));
    expect(r.lane).toBe('full');
    expect(r.reasons.join('\n')).toContain('data client access');
  });
  it('a reviewer-style alias with .. never resolves', () => {
    expect(resolveSpecifier('app/(marketing)/a.tsx', '@/components/ui/../../lib/supabase/service')).toBeNull();
    expect(resolveSpecifier('components/marketing/Hero.tsx', '../ui/Badge')).toBe('components/ui/Badge');
    expect(resolveSpecifier('components/ui/A.tsx', '../../../../etc/passwd')).toBeNull();
  });
  it('an SVG asset with script, event handlers or foreignObject is full', () => {
    expect(lane(change('public/a.svg', '<svg onload="x()"></svg>', 'A')).lane).toBe('full');
    expect(lane(change('public/c.svg', '<svg><foreignObject/></svg>', 'A')).lane).toBe('full');
    expect(lane(change('public/b.svg', '<svg><path d="M0"/></svg>', 'A')).lane).toBe('standard');
  });
  it('deleting a display-only file stays standard; deleting a data-access file is full', () => {
    expect(lane(change('components/ui/Old.tsx', 'export const Old = 1;', 'D')).lane).toBe('standard');
    expect(lane(change('components/ui/Old.tsx', "const r = await fetch('/x');", 'D')).lane).toBe('full');
  });
  it('a reviewer may raise to full and may never lower', () => {
    expect(classifyChanges([change('components/ui/A.tsx')], { raiseTo: 'full', readTarget })).toMatchObject({ lane: 'full', reasons: ['raised to full by reviewer'] });
    expect(() => classifyChanges([change('lib/payments/x.ts')], { raiseTo: 'standard' })).toThrow('A lane can only be raised to full, never lowered');
  });
  it('docs-only changes need one review and flag governance files', () => {
    expect(lane(change('docs/guide.md'), change('README.md'))).toMatchObject({ lane: 'standard', docs_only: true, governance: false, required_reviews: 1 });
    expect(lane(change('CLAUDE.md'))).toMatchObject({ docs_only: true, governance: true });
    expect(lane(change('RELEASE_GATE_V2.md'), change('lib/x.ts'))).toMatchObject({ lane: 'full', governance: true, required_reviews: 2 });
  });
  it('a document is docs-only only if no tooling reads it and it matches no full-lane path; the stricter class wins', () => {
    expect(lane(change('docs/MIGRATION_REGISTRY.md'))).toMatchObject({ lane: 'full', docs_only: false, reasons: ['docs/MIGRATION_REGISTRY.md: read by CI, release or gate tooling'] });
    for (const path of ['docs/sql/verify-production-321-322-postconditions.sql', 'scripts/reduced-release-gate.md', '.github/PULL_REQUEST_TEMPLATE.md', 'supabase/README.md', 'docs/contracts/736-capability-e2e-contract.md'])
      expect(lane(change(path))).toMatchObject({ lane: 'full', docs_only: false });
    expect(lane(change('docs/contracts/736-capability-e2e-contract.md')).governance).toBe(true);
  });
  it('every docs path that tooling source names is on the tooling-read list (no drift)', () => {
    const files = [...readdirSync('scripts').filter(f => /\.(mjs|sh)$/.test(f)).map(f => `scripts/${f}`), ...readdirSync('scripts/release-v3').filter(f => f.endsWith('.mjs')).map(f => `scripts/release-v3/${f}`),
      ...readdirSync('lib/release-gate').filter(f => f.endsWith('.ts')).map(f => `lib/release-gate/${f}`), ...readdirSync('.github/workflows').map(f => `.github/workflows/${f}`)];
    const named = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/['"`](docs\/[A-Za-z0-9_./-]+\.md|[A-Za-z0-9_-]+\.md)['"`]/g)) named.add(m[1]);
    const docsNamed = [...named].filter(p => /^docs\/(?!contracts\/)/.test(p) || !p.includes('/'));
    expect(docsNamed.filter(p => !TOOLING_READ_DOCS.includes(p))).toEqual([]);
  });
  it('an empty change list and malformed entries fail closed', () => {
    expect(lane().lane).toBe('full');
    expect(() => classifyChanges([{ path: 'a\nb', status: 'M', texts: [] }] as never)).toThrow('Invalid change entry');
    expect(() => classifyChanges([{ path: 'a', status: 'R', texts: [] }] as never)).toThrow('Invalid change entry');
    expect(() => classifyChanges([{ path: 'components/ui/A.tsx', status: 'M', texts: ['only one'] }])).toThrow('Missing file contents');
  });
});

describe('Release V3 lane classifier: git diff reading', { timeout: 60_000 }, () => {
  function repo(files: Record<string, string>, next: Record<string, string | null>, links: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'v3-classify-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    const write = (set: Record<string, string | null>) => { for (const [p, c] of Object.entries(set)) { if (c === null) rmSync(join(dir, p)); else { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); } } };
    write(files); g('add', '-A'); g('commit', '-qm', 'base'); const base = g('rev-parse', 'HEAD');
    write(next);
    for (const [p, t] of Object.entries(links)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); symlinkSync(t, join(dir, p)); }
    g('add', '-A'); g('commit', '-qm', 'next'); return { dir, base, target: g('rev-parse', 'HEAD') };
  }
  it('reads whole before/after files, including paths with parentheses and non-ASCII', () => {
    const r = repo({ 'app/(marketing)/a/page.tsx': "import { createClient } from '@/lib/supabase/client';\nexport default 1;\n" },
      { 'app/(marketing)/a/page.tsx': 'export default 2;\n', 'components/ui/Ünï.tsx': "'use server';\n" });
    const changes = collectChanges(r.dir, r.base, r.target);
    expect(changes.map(c => c.path)).toEqual(['app/(marketing)/a/page.tsx', 'components/ui/Ünï.tsx']);
    expect(changes[0].texts).toHaveLength(2);
    const result = classifyRange(r.dir, r.base, r.target);
    expect(result.lane).toBe('full');
    // The risky import exists only in the BEFORE version; it still makes the change full.
    expect(result.reasons.join('\n')).toContain('app/(marketing)/a/page.tsx: data client access');
    expect(result.reasons.join('\n')).toContain('Ünï.tsx: server action directive');
    rmSync(r.dir, { recursive: true, force: true });
  });
  it('treats renames as delete plus add, so a moved payment file is still full', () => {
    const r = repo({ 'lib/payments/a.ts': 'export const a = 1;\n' }, { 'lib/payments/a.ts': null, 'components/ui/a.ts': 'export const a = 1;\n' });
    const changes = collectChanges(r.dir, r.base, r.target);
    expect(changes.map(c => [c.path, c.status])).toEqual([['components/ui/a.ts', 'A'], ['lib/payments/a.ts', 'D']]);
    expect(classifyChanges(changes).lane).toBe('full');
    rmSync(r.dir, { recursive: true, force: true });
  });
  it('reads file modes, so a symlink inside a display-only folder is full', () => {
    const r = repo({ 'components/ui/A.tsx': 'export const A = 1;\n' }, {}, { 'components/ui/B.tsx': '../../lib/supabase/service.ts' });
    expect(classifyRange(r.dir, r.base, r.target).reasons).toContain('components/ui/B.tsx: symlink or submodule');
    rmSync(r.dir, { recursive: true, force: true });
  });
  it('follows imports into repository modules at the target', () => {
    const r = repo({ 'components/ui/Data.tsx': "export const d = () => fetch('/x');\n", 'app/(marketing)/p/page.tsx': 'export default 1;\n' },
      { 'app/(marketing)/p/page.tsx': "import { d } from '@/components/ui/Data';\nexport default 1;\n" });
    expect(classifyRange(r.dir, r.base, r.target).reasons.join('\n')).toContain('components/ui/Data.tsx: network call');
    rmSync(r.dir, { recursive: true, force: true });
  });
  it('the #840–#842 release range (73377818..bdc007a8) is full lane', () => {
    const result = classifyRange(process.cwd(), '73377818e16b02bdcbc2b8251445354b2e26877c', 'bdc007a8f93febeee8ce054d075d48894afd37bb');
    expect(result.lane).toBe('full');
    for (const reason of ['supabase/migrations/508_business_control_columns_guard.sql', 'lib/channels/channel-resolver.ts', '.github/workflows/ci.yml', 'app/api/reseller/accounts/route.ts', 'app/m/resolve.ts'])
      expect(result.reasons.join('\n')).toContain(reason);
  });
  it('the governance-docs PR #844 is docs-only with one review and the governance flag', () => {
    const base = execFileSync('git', ['rev-parse', 'bfee08b66ce5077efb52e8f23dae083471c9a8b1^1'], { encoding: 'utf8' }).trim();
    expect(classifyRange(process.cwd(), base, 'bfee08b66ce5077efb52e8f23dae083471c9a8b1')).toMatchObject({ lane: 'standard', docs_only: true, governance: true, required_reviews: 1 });
  });
});
