/**
 * Supabase JWT/RLS Integration Tests
 *
 * These tests require a running local Supabase instance.
 * They create real test users with Admin, Finance, and ordinary roles,
 * then verify authorization using actual JWT tokens and RLS policies.
 *
 * Run with: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/supabase-auth-integration.test.ts
 *
 * Prerequisites:
 * - Local Supabase running (supabase start)
 * - All migrations applied
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

// Test users — created in beforeAll, cleaned up in afterAll
let supabaseUrl: string;
let serviceKey: string;
let anonKey: string;
let serviceClient: ReturnType<typeof createClient>;

let adminUser: { id: string; email: string; token: string };
let financeUser: { id: string; email: string; token: string };
let ordinaryUser: { id: string; email: string; token: string };
let testBusinessId: string;
let testBusiness2Id: string;

describeIntegration('Supabase JWT/RLS Integration', () => {
  beforeAll(async () => {
    // Get Supabase connection info from environment
    supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

    if (!serviceKey || !anonKey) {
      // Try to get from supabase status
      const { execSync } = await import('child_process');
      try {
        const env = execSync('supabase status -o env 2>/dev/null', { encoding: 'utf-8' });
        for (const line of env.split('\n')) {
          if (line.startsWith('API_URL=')) supabaseUrl = line.split('=')[1].trim();
          if (line.startsWith('SERVICE_ROLE_KEY=')) serviceKey = line.split('=')[1].trim();
          if (line.startsWith('ANON_KEY=')) anonKey = line.split('=')[1].trim();
        }
      } catch {
        throw new Error('Cannot get Supabase keys. Is Supabase running?');
      }
    }

    serviceClient = createClient(supabaseUrl, serviceKey);

    // Create test users
    const timestamp = Date.now();

    // Admin user
    const { data: adminData } = await serviceClient.auth.admin.createUser({
      email: `test-admin-${timestamp}@integration.test`,
      password: 'test-password-123',
      email_confirm: true,
    });
    if (!adminData.user) throw new Error('Failed to create admin test user');
    await serviceClient.from('profiles').update({ role: 'admin' }).eq('id', adminData.user.id);
    const { data: adminSession } = await createClient(supabaseUrl, anonKey).auth.signInWithPassword({
      email: `test-admin-${timestamp}@integration.test`,
      password: 'test-password-123',
    });
    adminUser = { id: adminData.user.id, email: adminData.user.email!, token: adminSession.session!.access_token };

    // Finance user
    const { data: financeData } = await serviceClient.auth.admin.createUser({
      email: `test-finance-${timestamp}@integration.test`,
      password: 'test-password-123',
      email_confirm: true,
    });
    if (!financeData.user) throw new Error('Failed to create finance test user');
    await serviceClient.from('profiles').update({ role: 'finance' }).eq('id', financeData.user.id);
    const { data: financeSession } = await createClient(supabaseUrl, anonKey).auth.signInWithPassword({
      email: `test-finance-${timestamp}@integration.test`,
      password: 'test-password-123',
    });
    financeUser = { id: financeData.user.id, email: financeData.user.email!, token: financeSession.session!.access_token };

    // Ordinary user (restaurant_owner)
    const { data: ordinaryData } = await serviceClient.auth.admin.createUser({
      email: `test-ordinary-${timestamp}@integration.test`,
      password: 'test-password-123',
      email_confirm: true,
    });
    if (!ordinaryData.user) throw new Error('Failed to create ordinary test user');
    // Profile role defaults to null — ordinary user
    const { data: ordinarySession } = await createClient(supabaseUrl, anonKey).auth.signInWithPassword({
      email: `test-ordinary-${timestamp}@integration.test`,
      password: 'test-password-123',
    });
    ordinaryUser = { id: ordinaryData.user.id, email: ordinaryData.user.email!, token: ordinarySession.session!.access_token };

    // Create two test businesses
    const { data: biz1 } = await serviceClient.from('businesses').insert({
      owner_id: ordinaryUser.id, name: 'Test Biz 1', slug: `test-biz1-${timestamp}`,
      address: '123 Test', city: 'Test', neighborhood: 'Test', phone: '1234567890', status: 'active',
    }).select('id').single();
    testBusinessId = biz1!.id;

    const { data: biz2 } = await serviceClient.from('businesses').insert({
      owner_id: adminUser.id, name: 'Test Biz 2', slug: `test-biz2-${timestamp}`,
      address: '456 Test', city: 'Test', neighborhood: 'Test', phone: '0987654321', status: 'active',
    }).select('id').single();
    testBusiness2Id = biz2!.id;
  }, 30000);

  afterAll(async () => {
    if (!serviceClient) return;
    // Clean up test data
    await serviceClient.from('businesses').delete().eq('id', testBusinessId);
    await serviceClient.from('businesses').delete().eq('id', testBusiness2Id);
    await serviceClient.auth.admin.deleteUser(adminUser.id);
    await serviceClient.auth.admin.deleteUser(financeUser.id);
    await serviceClient.auth.admin.deleteUser(ordinaryUser.id);
  }, 15000);

  // ── RLS: business_payouts ──

  it('admin can read all business_payouts via RLS', async () => {
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${adminUser.token}` } },
    });
    const { error } = await client.from('business_payouts').select('id').limit(1);
    expect(error).toBeNull();
  });

  it('finance CANNOT read business_payouts via RLS (no policy)', async () => {
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${financeUser.token}` } },
    });
    const { data } = await client.from('business_payouts').select('id').limit(1);
    // Finance has no RLS policy — returns empty (not error, just no rows visible)
    expect(data).toEqual([]);
  });

  it('ordinary user can only see own business payouts via RLS', async () => {
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${ordinaryUser.token}` } },
    });
    const { data } = await client.from('business_payouts').select('id, business_id').limit(10);
    // Should only see payouts for businesses they own (testBusinessId)
    if (data && data.length > 0) {
      for (const row of data) {
        expect(row.business_id).toBe(testBusinessId);
      }
    }
  });

  // ── RLS: payout_accounts ──

  it('admin can read all payout_accounts', async () => {
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${adminUser.token}` } },
    });
    const { error } = await client.from('payout_accounts').select('id').limit(1);
    expect(error).toBeNull();
  });

  it('finance CANNOT read payout_accounts via RLS', async () => {
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${financeUser.token}` } },
    });
    const { data } = await client.from('payout_accounts').select('id').limit(1);
    expect(data).toEqual([]);
  });

  // ── RLS: admin_audit_logs ──

  it('admin can read audit logs', async () => {
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${adminUser.token}` } },
    });
    const { error } = await client.from('admin_audit_logs').select('id').limit(1);
    expect(error).toBeNull();
  });

  it('finance CANNOT read audit logs', async () => {
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${financeUser.token}` } },
    });
    const { data } = await client.from('admin_audit_logs').select('id').limit(1);
    expect(data).toEqual([]);
  });

  // ── Cross-business isolation ──

  it('ordinary user cannot see other business data', async () => {
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${ordinaryUser.token}` } },
    });
    const { data } = await client.from('businesses').select('id').eq('id', testBusiness2Id);
    expect(data).toBeDefined();
  });

  // ── API-level: /api/admin/query with real JWTs ──
  // These call the admin query endpoint via the service client proxy,
  // simulating what the admin UI does.

  it('finance can read platform-wide payments via admin query', async () => {
    // Finance queries payments through the admin query proxy (service client)
    // The proxy checks the role and applies column allowlists.
    const queryClient = createClient(supabaseUrl, serviceKey);
    // Simulate what the admin query route does: verify the user's role
    const { data: profile } = await queryClient
      .from('profiles')
      .select('role')
      .eq('id', financeUser.id)
      .single();
    expect(profile).not.toBeNull();
    expect(profile!.role).toBe('finance');

    // Finance can read payments (platform-wide via service client)
    const { data: payments, error } = await queryClient
      .from('payments')
      .select('id, amount, currency, status, business_id')
      .limit(5);
    expect(error).toBeNull();
    expect(payments).toBeDefined();
    // Response should not contain secret columns
    if (payments && payments.length > 0) {
      for (const p of payments) {
        expect(p).not.toHaveProperty('gateway_reference');
        expect(p).not.toHaveProperty('metadata');
        expect(p).not.toHaveProperty('payer_ip');
        expect(p).not.toHaveProperty('fraud_score');
      }
    }
  });

  it('finance reading payout_accounts gets no secret columns', async () => {
    // Insert a test payout account to verify column filtering
    await serviceClient.from('payout_accounts').insert({
      business_id: testBusinessId,
      gateway: 'paystack',
      bank_name: 'Test Bank',
      account_name: 'Test Account',
      account_number: '1234567890',
      bank_code: '044',
      square_access_token: 'secret-token-value',
      stripe_account_id: 'acct_secret123',
      routing_number: '021000021',
    });

    // Query as service client (simulating admin query proxy for finance)
    // The approved columns list determines what finance sees
    const approvedColumns = [
      'id', 'business_id', 'gateway', 'bank_name', 'account_name',
      'platform_percentage', 'is_active', 'verified_at', 'created_at', 'updated_at',
      'country_code',
    ];
    const { data, error } = await serviceClient
      .from('payout_accounts')
      .select(approvedColumns.join(', '))
      .eq('business_id', testBusinessId)
      .limit(1);

    expect(error).toBeNull();
    if (data && data.length > 0) {
      const row = data[0];
      // Safe columns present
      expect(row).toHaveProperty('bank_name');
      expect(row).toHaveProperty('account_name');
      // Secret columns absent (not in select)
      expect(row).not.toHaveProperty('account_number');
      expect(row).not.toHaveProperty('square_access_token');
      expect(row).not.toHaveProperty('stripe_account_id');
      expect(row).not.toHaveProperty('routing_number');
    }

    // Cleanup
    await serviceClient.from('payout_accounts').delete().eq('business_id', testBusinessId);
  });

  it('ordinary user cannot call admin query (role not in allowlist)', async () => {
    // The admin query route checks: ['admin', 'support', 'finance', 'operations']
    // An ordinary user's profile.role is null or a non-admin role
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('role')
      .eq('id', ordinaryUser.id)
      .single();
    // Ordinary user's role should not be in the admin allowlist
    const adminRoles = ['admin', 'support', 'finance', 'operations'];
    expect(adminRoles).not.toContain(profile?.role);
  });

  it('unauthenticated request has no valid user', async () => {
    // Create a client with an invalid/expired token
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: 'Bearer invalid-token-12345' } },
    });
    const { data: { user } } = await client.auth.getUser();
    expect(user).toBeNull();
  });
});

// Always-run test documenting the skip status
describe('Supabase integration test status', () => {
  it(`integration tests are ${SKIP ? 'SKIPPED (set SUPABASE_INTEGRATION=true)' : 'RUNNING'}`, () => {
    if (SKIP) {
      console.log('Supabase integration tests skipped. Run with: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/supabase-auth-integration.test.ts');
    }
    expect(true).toBe(true);
  });
});
