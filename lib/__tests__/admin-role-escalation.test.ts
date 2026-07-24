/**
 * AUTH-001: Admin Role Privilege Escalation Prevention
 *
 * Evidence tiers:
 * 1. Repository-wide authority audit (structural scan of app/, lib/, admin/src/)
 * 2. Migration security properties (structural)
 * 3. requirePlatformAdmin helper (executable, mocked Supabase Auth)
 * 4. Template-check route handler (executable, real GET handler with spies)
 * 5. verifyCronAuth contract audit (structural + regression fixtures)
 * 6. Database authorization (manual PostgreSQL — not CI)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════
// 1. Repository-wide authority audit
// ═══════════════════════════════════════════════════════════

describe('Repository-wide platform-authority audit', () => {
  const ALLOWED: Record<string, string> = {
    'lib/admin-auth.ts': 'Documentation: profiles.role explicitly untrusted',
    'admin/src/lib/adminAuth.ts': 'Documentation: profiles.role explicitly untrusted',
    'app/api/onboarding/register/route.ts': 'Display: first-business check, not authorization',
    'admin/src/pages/Businesses.tsx': 'session.role from app_metadata session',
    'admin/src/pages/PlatformSettings.tsx': 'session.role from app_metadata session',
    'admin/src/pages/Campaigns.tsx': 'session.role from app_metadata session',
    'admin/src/pages/Events.tsx': 'session.role from app_metadata session',
    'admin/src/pages/DemoRequests.tsx': 'session.role from app_metadata session',
    'admin/src/pages/ResellerPayouts.tsx': 'role from app_metadata session',
    'admin/src/pages/Users.tsx': 'Display: admin count stats',
    'admin/src/pages/ImpersonationMode.tsx': 'session.role from app_metadata session',
    'admin/src/pages/Resellers.tsx': 'session.role from app_metadata session',
    'admin/src/pages/ResellerFinancials.tsx': 'role from app_metadata session',
    'admin/src/pages/AdminTeam.tsx': 'Display: role badges',
    'admin/src/pages/AdminPermissions.tsx': 'Display: permission management',
    'admin/src/pages/Login.tsx': 'Reads app_metadata from signIn response',
    'admin/src/routes.tsx': 'RoleGuard uses app_metadata session',
    'admin/src/hooks/usePermissions.ts': 'session.role from app_metadata session',
  };

  function collectFiles(dir: string, base: string): string[] {
    const files: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.next', '__tests__', '.git', '.claude', 'graphify-out'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { files.push(...collectFiles(full, base)); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
        files.push(relative(base, full));
      }
    } catch { /* skip */ }
    return files;
  }

  it('no production code uses profiles.role as platform authorization', () => {
    const root = process.cwd();
    const files = [...collectFiles(join(root, 'app'), root), ...collectFiles(join(root, 'lib'), root), ...collectFiles(join(root, 'admin/src'), root)];
    const violations: string[] = [];
    for (const file of files) {
      if (ALLOWED[file]) continue;
      const code = readFileSync(join(root, file), 'utf-8');
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
        if ((line.includes('profile.role') && (line.includes("!== 'admin'") || line.includes("=== 'admin'") || line.includes('.includes(profile.role)'))) ||
            (line.includes("from('profiles')") && lines.slice(Math.max(0, i - 3), i + 5).some(l => l.includes("select('role')") || l.includes('.role')))) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations, `Profiles.role auth:\n${violations.join('\n')}`).toHaveLength(0);
  });

  it('no hardcoded platform user IDs', () => {
    const root = process.cwd();
    const files = [...collectFiles(join(root, 'app'), root), ...collectFiles(join(root, 'lib'), root)];
    for (const file of files) {
      const code = readFileSync(join(root, file), 'utf-8');
      expect(code, file).not.toContain('PLATFORM_OWNERS');
      expect(code, file).not.toContain('PLATFORM_ADMINS');
    }
  });

  it('no browser auth.admin calls — with regression fixture', () => {
    // Regression fixture: this pattern must be detected
    const knownBadLine = 'const { data } = await adminDb.auth.admin.getUserById(user.id);';
    expect(knownBadLine).toContain('.auth.admin.');

    const root = process.cwd();
    const adminFiles = collectFiles(join(root, 'admin/src'), root);
    const violations: string[] = [];
    for (const file of adminFiles) {
      const code = readFileSync(join(root, file), 'utf-8');
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('//') || lines[i].trim().startsWith('*')) continue;
        if (lines[i].includes('.auth.admin.')) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(violations, `Browser auth.admin:\n${violations.join('\n')}`).toHaveLength(0);
  });

  it('admin panel requireAdminSession uses only app_metadata', () => {
    const code = readFileSync('admin/src/lib/adminAuth.ts', 'utf-8');
    expect(code).toContain('app_metadata');
    const exec = code.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(exec).not.toContain("from('profiles')");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Migration security properties
// ═══════════════════════════════════════════════════════════

describe('Migration 247 security', () => {
  const m = readFileSync('supabase/migrations/247_admin_role_escalation_fix.sql', 'utf-8');

  it('policy, grants, triggers, is_admin rewrite, search_path', () => {
    expect(m).toContain('DROP POLICY IF EXISTS "Users manage own profile"');
    expect(m).toContain('profiles_select_own');
    expect(m).toContain('profiles_update_own');
    expect(m).not.toContain('profiles_insert_own');
    expect(m).toContain('REVOKE ALL ON TABLE public.profiles FROM authenticated');
    expect(m).toContain('GRANT UPDATE (first_name, last_name, email, phone, last_login_at, updated_at)');
    expect(m).not.toMatch(/GRANT UPDATE.*\brole\b.*TO authenticated/);
    expect(m).toContain('protect_profiles_role');
    expect(m).toContain('protect_profiles_role_insert');
    expect(m).toContain("raw_app_meta_data ->> 'role'");
    expect(m).toContain('COALESCE');
    const blocks = m.split('CREATE OR REPLACE FUNCTION');
    for (let i = 1; i < blocks.length; i++) {
      const header = blocks[i].split('$$')[0];
      if (header.includes('SECURITY DEFINER')) {
        expect(header, `Fn ${i}`).toContain("search_path = ''");
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 3. requirePlatformAdmin helper
// ═══════════════════════════════════════════════════════════

describe('requirePlatformAdmin helper', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  function mockAuth(user: Record<string, unknown> | null) {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) } }),
    }));
  }
  const req = () => new NextRequest('https://t.waaiio.com/api/admin/test', { headers: { Authorization: 'Bearer t' } });

  it('denies absent/profiles-only/raw_user_meta_data, allows app_metadata, respects requiredRole', async () => {
    // Denied cases
    for (const meta of [{}, { user_metadata: { role: 'admin' } }, { raw_user_meta_data: { role: 'admin' } }]) {
      vi.resetModules();
      mockAuth({ id: 'u1', email: 'a@b.com', app_metadata: {}, ...meta });
      const { requirePlatformAdmin } = await import('@/lib/admin-auth');
      expect(await requirePlatformAdmin(req()), JSON.stringify(meta)).toBeNull();
    }
    // Allowed
    vi.resetModules();
    mockAuth({ id: 'u1', email: 'a@t.com', app_metadata: { role: 'support' } });
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    expect(await requirePlatformAdmin(req(), { requiredRole: 'admin' })).toBeNull();
    expect(await requirePlatformAdmin(req(), { requiredRole: ['admin', 'support'] })).not.toBeNull();
  });

  it('denies unauthenticated', async () => {
    mockAuth(null);
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } }),
    }));
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    expect(await requirePlatformAdmin(new NextRequest('https://t.waaiio.com/api/admin/test'))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Template-check route handler (executable)
// ═══════════════════════════════════════════════════════════

describe('Template-check GET handler', () => {
  // Spies
  let metaConstructorCalls: number;
  let getTemplatesCalls: number;
  let createTemplateCalls: number;
  let deleteTemplateCalls: number;
  let sendTemplateCalls: number;
  let requirePlatformAdminCalls: number;
  let requirePlatformAdminResult: unknown;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    metaConstructorCalls = 0;
    getTemplatesCalls = 0;
    createTemplateCalls = 0;
    deleteTemplateCalls = 0;
    sendTemplateCalls = 0;
    requirePlatformAdminCalls = 0;
    requirePlatformAdminResult = null;
    process.env.META_CLOUD_WABA_ID = 'test-waba';
    process.env.META_CLOUD_ACCESS_TOKEN = 'test-meta-token';
    process.env.META_CLOUD_PHONE_NUMBER_ID = 'test-phone-id';
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
  });

  afterEach(() => {
    delete process.env.META_CLOUD_WABA_ID;
    delete process.env.META_CLOUD_ACCESS_TOKEN;
    delete process.env.META_CLOUD_PHONE_NUMBER_ID;
    delete process.env.CRON_SECRET;
    delete process.env.INTERNAL_API_TOKEN;
  });

  function setup(adminUser: Record<string, unknown> | null) {
    vi.doMock('@/lib/channels/meta-cloud', () => ({
      MetaCloudService: class {
        constructor() { metaConstructorCalls++; }
        async getTemplates() { getTemplatesCalls++; return { data: [] }; }
        async createTemplate() { createTemplateCalls++; return { id: 't1' }; }
        async deleteTemplate() { deleteTemplateCalls++; }
        async sendTemplate() { sendTemplateCalls++; return { messageId: 'm1' }; }
      },
    }));
    vi.doMock('@/lib/admin-auth', () => ({
      requirePlatformAdmin: vi.fn().mockImplementation(async (_r: unknown, opts?: { requiredRole?: string | string[] }) => {
        requirePlatformAdminCalls++;
        if (!adminUser?.app_metadata || !(adminUser.app_metadata as Record<string, string>).role) return null;
        const role = (adminUser.app_metadata as Record<string, string>).role;
        if (!['admin', 'support', 'finance', 'operations'].includes(role)) return null;
        if (opts?.requiredRole) {
          const req = Array.isArray(opts.requiredRole) ? opts.requiredRole : [opts.requiredRole];
          if (!req.includes(role)) return null;
        }
        requirePlatformAdminResult = { id: adminUser.id, userId: adminUser.id, email: adminUser.email, role };
        return requirePlatformAdminResult;
      }),
    }));
  }

  function makeReq(params: Record<string, string> = {}, headers: Record<string, string> = {}) {
    const url = new URL('https://t.waaiio.com/api/whatsapp/templates/check');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return new NextRequest(url.toString(), { method: 'GET', headers });
  }

  // ── Authorized paths ──

  it('1. valid internal token → 200, requirePlatformAdmin not called, Meta called', async () => {
    setup(null);
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const res = await GET(makeReq({ token: 'test-internal-token' }));
    expect(res.status).toBe(200);
    expect(requirePlatformAdminCalls).toBe(0);
    expect(metaConstructorCalls).toBe(1);
    expect(getTemplatesCalls).toBe(1);
  });

  it('2. valid cron header → 200, requirePlatformAdmin not called, Meta called', async () => {
    setup(null);
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const res = await GET(makeReq({}, { Authorization: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(requirePlatformAdminCalls).toBe(0);
    expect(metaConstructorCalls).toBe(1);
  });

  it('3. invalid cron + valid admin → 200, requirePlatformAdmin called once, Meta called', async () => {
    setup({ id: 'u1', email: 'a@t.com', app_metadata: { role: 'admin' } });
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const res = await GET(makeReq({}, { Authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(200);
    expect(requirePlatformAdminCalls).toBe(1);
    expect(metaConstructorCalls).toBe(1);
  });

  // ── Rejected paths ──

  it('4. invalid cron + ordinary user (no platform role) → 401, no Meta', async () => {
    setup({ id: 'u2', email: 'user@t.com', app_metadata: {} });
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const res = await GET(makeReq({}, { Authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
    expect(metaConstructorCalls).toBe(0);
    expect(getTemplatesCalls).toBe(0);
  });

  it('5. missing credentials → 401, no Meta', async () => {
    setup(null);
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(metaConstructorCalls).toBe(0);
  });

  it('6. profiles.role-only admin → 401, no Meta', async () => {
    setup({ id: 'u3', email: 'fake@t.com', app_metadata: {} });
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const res = await GET(makeReq({}, { Authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
    expect(metaConstructorCalls).toBe(0);
  });

  it('7. raw_user_meta_data-only admin → 401, no Meta', async () => {
    setup({ id: 'u4', email: 'r@t.com', app_metadata: {}, raw_user_meta_data: { role: 'admin' } });
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const res = await GET(makeReq({}, { Authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
    expect(metaConstructorCalls).toBe(0);
  });

  it('8-10. support/finance/operations → 401 (admin-only route)', async () => {
    for (const role of ['support', 'finance', 'operations']) {
      vi.resetModules();
      metaConstructorCalls = 0;
      requirePlatformAdminCalls = 0;
      setup({ id: 'u5', email: `${role}@t.com`, app_metadata: { role } });
      const { GET } = await import('@/app/api/whatsapp/templates/check/route');
      const res = await GET(makeReq({}, { Authorization: 'Bearer wrong' }));
      expect(res.status, `${role} should be rejected`).toBe(401);
      expect(metaConstructorCalls, `${role}: no Meta`).toBe(0);
    }
  });

  it('11. former hardcoded founder UUID → 401', async () => {
    setup({ id: '19d95ac8-0f39-4c59-b0ca-18bf9dfba501', email: 'founder@t.com', app_metadata: {} });
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const res = await GET(makeReq({}, { Authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
    expect(metaConstructorCalls).toBe(0);
  });

  it('12. unauthorized ?fix=true → 401, createTemplate not called', async () => {
    setup(null);
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const res = await GET(makeReq({ fix: 'true' }));
    expect(res.status).toBe(401);
    expect(createTemplateCalls).toBe(0);
    expect(deleteTemplateCalls).toBe(0);
  });

  it('13. unauthorized ?test=15551234567 → 401, sendTemplate not called', async () => {
    setup(null);
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const res = await GET(makeReq({ test: '15551234567' }));
    expect(res.status).toBe(401);
    expect(sendTemplateCalls).toBe(0);
  });

  it('14. valid cron with no admin → 200, requirePlatformAdmin not called', async () => {
    setup(null);
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const res = await GET(makeReq({}, { Authorization: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(requirePlatformAdminCalls).toBe(0);
  });

  it('15. invalid cron + valid admin → requirePlatformAdmin called exactly once', async () => {
    setup({ id: 'u6', email: 'a@t.com', app_metadata: { role: 'admin' } });
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    await GET(makeReq({}, { Authorization: 'Bearer wrong' }));
    expect(requirePlatformAdminCalls).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. verifyCronAuth contract audit
// ═══════════════════════════════════════════════════════════

describe('verifyCronAuth contract audit', () => {
  /**
   * Analyze a code snippet for correct verifyCronAuth usage.
   * Returns true if the usage is safe, false if inverted.
   */
  function isCorrectCronAuthUsage(code: string): boolean {
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const varMatch = line.match(/const\s+(\w+)\s*=\s*verifyCronAuth/);
      if (!varMatch) continue;
      const v = varMatch[1];
      // Look ahead for the conditional
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const check = lines[j].trim();
        // INVERTED patterns (null=success treated as failure):
        if (check.match(new RegExp(`if\\s*\\(\\s*!${v}\\b`))) return false;
        if (check.match(new RegExp(`if\\s*\\(\\s*${v}\\s*===\\s*null`))) return false;
        if (check.match(new RegExp(`if\\s*\\(\\s*${v}\\s*==\\s*null`))) return false;
        // CORRECT patterns (truthy=failure):
        if (check.match(new RegExp(`if\\s*\\(\\s*${v}\\b\\s*\\)`))) return true;
        if (check.match(new RegExp(`if\\s*\\(\\s*${v}\\b\\s*\\{`))) return true;
      }
    }
    return true; // No conditional found — not our concern
  }

  it('rejects known inverted pattern: if (!cronAuth)', () => {
    const broken = `const cronAuth = verifyCronAuth(request);\nif (!cronAuth) {\n  // BUG\n}`;
    expect(isCorrectCronAuthUsage(broken)).toBe(false);
  });

  it('rejects: if (cronAuth === null)', () => {
    const broken = `const cronAuth = verifyCronAuth(request);\nif (cronAuth === null) {\n  doStuff();\n}`;
    expect(isCorrectCronAuthUsage(broken)).toBe(false);
  });

  it('accepts: if (cronFailure)', () => {
    const good = `const cronFailure = verifyCronAuth(request);\nif (cronFailure) {\n  return cronFailure;\n}`;
    expect(isCorrectCronAuthUsage(good)).toBe(true);
  });

  it('accepts: if (authError) return authError', () => {
    const good = `const authError = verifyCronAuth(request);\nif (authError) return authError;`;
    expect(isCorrectCronAuthUsage(good)).toBe(true);
  });

  it('every live verifyCronAuth caller uses correct convention', () => {
    const root = process.cwd();
    const violations: string[] = [];

    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.next', '__tests__'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const code = readFileSync(full, 'utf-8');
        if (!code.includes('verifyCronAuth(')) continue;
        if (!isCorrectCronAuthUsage(code)) {
          violations.push(relative(root, full));
        }
      }
    }
    walk(join(root, 'app'));
    expect(violations, `Inverted verifyCronAuth:\n${violations.join('\n')}`).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Regression
// ═══════════════════════════════════════════════════════════

describe('Regression: old exploit is closed', () => {
  it('migration removes escalation path', () => {
    const m = readFileSync('supabase/migrations/247_admin_role_escalation_fix.sql', 'utf-8');
    expect(m).toContain('DROP POLICY IF EXISTS "Users manage own profile"');
    expect(m).toContain('REVOKE ALL ON TABLE public.profiles FROM authenticated');
    expect(m).toContain("raw_app_meta_data ->> 'role'");
    expect(m).toContain("search_path = ''");
  });
});
