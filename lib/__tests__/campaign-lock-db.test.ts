/**
 * Campaign Lock Trigger — Real Database Integration Tests
 *
 * Tests the `protect_campaign_after_donations()` trigger (migrations 279/280)
 * which prevents modifying title, lowering goal below raised_amount,
 * or shortening end_date once donations have been received.
 *
 * Run: eval "$(supabase status -o env 2>/dev/null)" && \
 *   SUPABASE_INTEGRATION=true NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
 *   SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" npx vitest run lib/__tests__/campaign-lock-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testBizId: string;
let testUserId: string;

describeIntegration('Campaign lock trigger — real database', () => {
  beforeAll(async () => {
    const url =
      process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    let key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!key) {
      const { execSync } = await import('child_process');
      const env = execSync('supabase status -o env 2>/dev/null', {
        encoding: 'utf-8',
      });
      const keyLine = env
        .split('\n')
        .find((l) => l.startsWith('SERVICE_ROLE_KEY='));
      key = keyLine ? keyLine.split('=')[1].replace(/"/g, '').trim() : '';
    }
    db = createClient(url, key);

    const ts = Date.now();
    const { data: user } = await db.auth.admin.createUser({
      email: `camp-lock-${ts}@test.local`,
      password: 'test-123',
      email_confirm: true,
    });
    testUserId = user.user!.id;

    const { data: biz } = await db
      .from('businesses')
      .insert({
        owner_id: testUserId,
        name: `Camp Lock ${ts}`,
        slug: `camp-lock-${ts}`,
        address: '123',
        city: 'T',
        neighborhood: 'T',
        phone: '123',
        status: 'active',
      })
      .select('id')
      .single();
    testBizId = biz!.id;
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    await db.from('campaigns').delete().eq('business_id', testBizId);
    await db.from('businesses').delete().eq('id', testBizId);
    await db.auth.admin.deleteUser(testUserId);
  }, 15000);

  it('a) campaign with raised_amount > 0: title change rejected', async () => {
    const { data: camp } = await db
      .from('campaigns')
      .insert({
        business_id: testBizId,
        title: 'Original Title',
        goal_amount: 50000,
        raised_amount: 5000,
        status: 'active',
        end_date: '2027-12-31',
      })
      .select('id')
      .single();

    const { error } = await db
      .from('campaigns')
      .update({ title: 'New Title' })
      .eq('id', camp!.id);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('Cannot change campaign title');

    // Cleanup
    await db.from('campaigns').delete().eq('id', camp!.id);
  });

  it('b) campaign with raised_amount > 0: goal cannot be lowered below raised_amount', async () => {
    const { data: camp } = await db
      .from('campaigns')
      .insert({
        business_id: testBizId,
        title: 'Goal Test',
        goal_amount: 50000,
        raised_amount: 20000,
        status: 'active',
        end_date: '2027-12-31',
      })
      .select('id')
      .single();

    // Try to lower goal below raised_amount (20000)
    const { error } = await db
      .from('campaigns')
      .update({ goal_amount: 15000 })
      .eq('id', camp!.id);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('Cannot lower goal below raised amount');

    // Cleanup
    await db.from('campaigns').delete().eq('id', camp!.id);
  });

  it('c) campaign with raised_amount > 0: end_date cannot be shortened', async () => {
    const { data: camp } = await db
      .from('campaigns')
      .insert({
        business_id: testBizId,
        title: 'Date Test',
        goal_amount: 50000,
        raised_amount: 5000,
        status: 'active',
        end_date: '2027-12-31',
      })
      .select('id')
      .single();

    // Try to shorten end_date
    const { error } = await db
      .from('campaigns')
      .update({ end_date: '2027-06-01' })
      .eq('id', camp!.id);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('Cannot shorten campaign end date');

    // Cleanup
    await db.from('campaigns').delete().eq('id', camp!.id);
  });

  it('d) campaign with raised_amount = 0: all fields can be changed freely', async () => {
    const { data: camp } = await db
      .from('campaigns')
      .insert({
        business_id: testBizId,
        title: 'Free Change',
        goal_amount: 50000,
        raised_amount: 0,
        status: 'active',
        end_date: '2027-12-31',
      })
      .select('id')
      .single();

    // Change title
    const r1 = await db
      .from('campaigns')
      .update({ title: 'Changed Title' })
      .eq('id', camp!.id);
    expect(r1.error).toBeNull();

    // Lower goal
    const r2 = await db
      .from('campaigns')
      .update({ goal_amount: 10000 })
      .eq('id', camp!.id);
    expect(r2.error).toBeNull();

    // Shorten end_date
    const r3 = await db
      .from('campaigns')
      .update({ end_date: '2027-01-01' })
      .eq('id', camp!.id);
    expect(r3.error).toBeNull();

    // Verify all changes applied
    const { data: updated } = await db
      .from('campaigns')
      .select('title, goal_amount, end_date')
      .eq('id', camp!.id)
      .single();

    expect(updated!.title).toBe('Changed Title');
    expect(Number(updated!.goal_amount)).toBe(10000);
    expect(updated!.end_date).toBe('2027-01-01');

    // Cleanup
    await db.from('campaigns').delete().eq('id', camp!.id);
  });

  it('e) campaign with raised_amount > 0: goal CAN be raised (allowed)', async () => {
    const { data: camp } = await db
      .from('campaigns')
      .insert({
        business_id: testBizId,
        title: 'Raise Goal',
        goal_amount: 50000,
        raised_amount: 10000,
        status: 'active',
        end_date: '2027-12-31',
      })
      .select('id')
      .single();

    // Raise goal above current value — should succeed
    const { error } = await db
      .from('campaigns')
      .update({ goal_amount: 100000 })
      .eq('id', camp!.id);
    expect(error).toBeNull();

    // Verify new goal
    const { data: updated } = await db
      .from('campaigns')
      .select('goal_amount')
      .eq('id', camp!.id)
      .single();
    expect(Number(updated!.goal_amount)).toBe(100000);

    // Cleanup
    await db.from('campaigns').delete().eq('id', camp!.id);
  });
});

describe('Campaign lock trigger DB status', () => {
  it(`tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => {
    expect(true).toBe(true);
  });
});
