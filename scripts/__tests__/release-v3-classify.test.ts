import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { classifyChanges, collectChanges } from '../release-v3/classify.mjs';

const change = (path: string, added: string[] = ['export const x = 1;'], status = 'M') => ({ path, status, added });
const lane = (...changes: ReturnType<typeof change>[]) => classifyChanges(changes);

describe('Release V3 lane classifier: path', () => {
  it('standard: display-only marketing, ui and static assets', () => {
    const r = lane(change('app/(marketing)/about/page.tsx', ["import Link from 'next/link';", 'export default function About() { return <Link href="/x">Hi</Link>; }']),
      change('components/ui/Badge.tsx', ["import { cn } from '@/lib/utils';"]), change('public/logo.png', []), change('components/marketing/Hero.tsx', ["import { Badge } from '../ui/Badge';"]));
    expect(r).toMatchObject({ lane: 'standard', reasons: [], required_reviews: 1 });
  });
  it.each([
    'scripts/new-thing.mjs', 'lib/url.ts', 'app/dashboard/page.tsx', 'tsconfig.json', 'some/unknown/file.xyz',
  ])('unknown or non-allowlisted path %s routes to full', path => expect(lane(change(path))).toMatchObject({ lane: 'full', required_reviews: 2 }));
  it.each([
    'lib/payments/stripe.ts', 'app/api/webhooks/paystack/route.ts', 'app/api/payouts/route.ts', 'lib/payouts/accounting-hold.ts',
    'app/dashboard/payouts/page.tsx', 'admin/src/pages/Payouts.tsx', 'lib/bot/bot.service.ts', 'supabase/functions/x/index.ts',
  ])('payment, provider, bot or admin path %s routes to full', path => expect(lane(change(path)).lane).toBe('full'));
  it.each([
    'supabase/migrations/509_x.sql', '.github/workflows/ci.yml', 'package.json', 'package-lock.json', 'middleware.ts', 'next.config.js', 'vercel.json',
    'lib/supabase/client.ts', 'app/auth/callback/route.ts', 'scripts/release-v3/classify.mjs', 'supabase/catalog-deltas/509_x.json',
  ])('§9.3 always-full path %s routes to full', path => expect(lane(change(path)).lane).toBe('full'));
  it.each(['app/(marketing)/pricing/route.ts', 'app/(marketing)/actions.ts', 'app/(marketing)/sitemap.ts', 'components/ui/middleware.ts'])(
    'route handlers, actions and metadata files inside allowlisted folders are full: %s', path => expect(lane(change(path)).lane).toBe('full'));
  it('a binary or text asset outside the asset roots is full', () => expect(lane(change('lib/logo.png', [])).lane).toBe('full'));
});

describe('Release V3 lane classifier: content', () => {
  const page = 'app/(marketing)/pricing/page.tsx';
  it.each([
    ["'use server';", 'server action directive'],
    ['"use server"', 'server action directive'],
    ["import { createClient } from '@/lib/supabase/client';", 'imports @/lib/supabase/client'],
    ["import Stripe from 'stripe';", 'imports stripe'],
    ["import { send } from '@/lib/bot/bot.service';", 'imports @/lib/bot/bot.service'],
    ["import { x } from '../../../lib/payments/factory';", 'outside display-only paths'],
    ["const k = process.env.NEXT_PUBLIC_X;", 'environment read'],
    ["await fetch('/api/pricing');", 'network call'],
    ["localStorage.setItem('a', 'b');", 'storage or request-state access'],
    ["supabase.from('payments').select();", 'data client call'],
    ['<div dangerouslySetInnerHTML={{ __html: x }} />', 'raw HTML or script execution'],
    ['const m = await import(name);', 'dynamic import with computed specifier'],
    ["const fs = require('fs');", 'require call'],
  ])('allowlisted file whose diff adds %s is full', (line, reason) => {
    const r = lane(change(page, [line]));
    expect(r.lane).toBe('full');
    expect(r.reasons.join('\n')).toContain(reason);
  });
  it('an SVG asset with script or event handlers is full', () => {
    expect(lane(change('public/a.svg', ['<svg onload="x()"></svg>'])).lane).toBe('full');
    expect(lane(change('public/b.svg', ['<svg><path d="M0"/></svg>'])).lane).toBe('standard');
  });
  it('deleting a display-only file stays standard', () => expect(lane(change('components/ui/Old.tsx', [], 'D')).lane).toBe('standard'));
  it('a reviewer may raise to full and may never lower', () => {
    expect(classifyChanges([change('components/ui/A.tsx')], { raiseTo: 'full' })).toMatchObject({ lane: 'full', reasons: ['raised to full by reviewer'] });
    expect(() => classifyChanges([change('lib/payments/x.ts')], { raiseTo: 'standard' })).toThrow('never lowered');
  });
  it('docs-only changes need one review and flag governance files', () => {
    expect(lane(change('docs/guide.md'), change('README.md'))).toMatchObject({ lane: 'standard', docs_only: true, governance: false, required_reviews: 1 });
    expect(lane(change('CLAUDE.md'))).toMatchObject({ docs_only: true, governance: true });
    expect(lane(change('RELEASE_GATE_V2.md'), change('lib/x.ts'))).toMatchObject({ lane: 'full', governance: true, required_reviews: 2 });
  });
  it('an empty change list and malformed entries fail closed', () => {
    expect(lane().lane).toBe('full');
    expect(() => classifyChanges([{ path: 'a\nb', status: 'M', added: [] }] as never)).toThrow();
    expect(() => classifyChanges([{ path: 'a', status: 'R', added: [] }] as never)).toThrow();
  });
});

describe('Release V3 lane classifier: git diff reading', { timeout: 60_000 }, () => {
  function repo(files: Record<string, string>, next: Record<string, string | null>) {
    const dir = mkdtempSync(join(tmpdir(), 'v3-classify-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    const write = (set: Record<string, string | null>) => { for (const [p, c] of Object.entries(set)) { if (c === null) rmSync(join(dir, p)); else { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); } } };
    write(files); g('add', '-A'); g('commit', '-qm', 'base'); const base = g('rev-parse', 'HEAD');
    write(next); g('add', '-A'); g('commit', '-qm', 'next'); return { dir, base, target: g('rev-parse', 'HEAD') };
  }
  it('reads added lines per file, including paths with parentheses and non-ASCII', () => {
    const r = repo({ 'app/(marketing)/a/page.tsx': 'export default 1;\n' },
      { 'app/(marketing)/a/page.tsx': "export default 1;\nimport { createClient } from '@/lib/supabase/client';\n", 'components/ui/Ünï.tsx': "'use server';\n" });
    const changes = collectChanges(r.dir, r.base, r.target);
    expect(changes.map(c => c.path)).toEqual(['app/(marketing)/a/page.tsx', 'components/ui/Ünï.tsx']);
    const result = classifyChanges(changes);
    expect(result.lane).toBe('full');
    expect(result.reasons.join('\n')).toContain('imports @/lib/supabase/client');
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
  it('the #840–#842 release range (73377818..bdc007a8) is full lane', () => {
    const result = classifyChanges(collectChanges(process.cwd(), '73377818e16b02bdcbc2b8251445354b2e26877c', 'bdc007a8f93febeee8ce054d075d48894afd37bb'));
    expect(result.lane).toBe('full');
    for (const reason of ['supabase/migrations/508_business_control_columns_guard.sql', 'lib/channels/channel-resolver.ts', '.github/workflows/ci.yml', 'app/api/reseller/accounts/route.ts', 'app/m/resolve.ts'])
      expect(result.reasons.join('\n')).toContain(reason);
  });
});
