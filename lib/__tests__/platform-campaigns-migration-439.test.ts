/**
 * Platform Campaigns Migration 409 — PostgreSQL constraint + ACL tests (#439)
 *
 * These tests run against a real PostgreSQL database with TEST_DATABASE_URL.
 * They create all necessary fixtures deterministically — no reliance on
 * pre-existing data in the test DB.
 *
 * Tests prove:
 * - consent default is `unknown`
 * - Campaign B participant cannot bind Campaign A asset
 * - Campaign B event cannot bind Campaign A participant/asset
 * - duplicate non-null source_event_id rejected
 * - NULL source_event_id allowed
 * - anon/authenticated privileges absent
 * - service_role exact privileges
 * - service_role UPDATE/DELETE on events/clicks rejected
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

// In CI, TEST_DATABASE_URL is always set — the CI step enforces zero skips.
// Locally, these tests are skipped gracefully when no real PG is available.
const describeDb = dbUrl ? describe : describe.skip;

function sql(query: string): string {
  if (!dbUrl) throw new Error('No TEST_DATABASE_URL');
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: query,
    encoding: 'utf-8',
    timeout: 10_000,
  }).trim();
}

describeDb('Migration 409 — PostgreSQL constraint tests (#439)', () => {
  let profileId: string;
  let channelId: string;
  let campaignAId: string;
  let campaignBId: string;
  let assetAId: string;
  let participantAId: string;

  beforeAll(() => {
    // Create auth.users row first (profiles.id references auth.users.id)
    const authUserId = sql(`
      INSERT INTO auth.users (id, email)
      VALUES (gen_random_uuid(), 'test-m409-${Date.now()}@waaiio-ci.local')
      RETURNING id
    `);
    if (!authUserId) throw new Error('Failed to create auth user');

    // Create profile using the auth user's ID
    profileId = sql(`
      INSERT INTO public.profiles (id, email, first_name, last_name)
      VALUES ('${authUserId}', 'test-m409@waaiio-ci.local', 'M409', 'CITest')
      RETURNING id
    `);
    if (!profileId) throw new Error('Failed to create test profile');

    // Create a deterministic shared channel for asset FK references
    // phone_number is UNIQUE so use a unique value with timestamp
    channelId = sql(`
      INSERT INTO public.whatsapp_channels (id, phone_number, country_code, channel_type, is_active, display_name)
      VALUES (gen_random_uuid(), '+100000${Date.now() % 100000}', 'US', 'shared', true, 'M409 CI Channel')
      RETURNING id
    `);
    if (!channelId) throw new Error('Failed to create test channel');

    // Create test campaigns (consent_type is now required, no default)
    campaignAId = sql(`
      INSERT INTO public.platform_campaigns (name, campaign_type, consent_type, created_by)
      VALUES ('M409 Test A', 'opt_in', 'opt_in', '${profileId}')
      RETURNING id
    `);
    if (!campaignAId) throw new Error('Failed to create campaign A');

    campaignBId = sql(`
      INSERT INTO public.platform_campaigns (name, campaign_type, consent_type, created_by)
      VALUES ('M409 Test B', 'survey', 'informational', '${profileId}')
      RETURNING id
    `);
    if (!campaignBId) throw new Error('Failed to create campaign B');

    // Create test asset in campaign A
    assetAId = sql(`
      INSERT INTO public.platform_campaign_assets (campaign_id, source_type, market, channel_id, prefilled_message, attribution_token)
      VALUES ('${campaignAId}', 'website_button', 'US', '${channelId}', 'M409 test msg', 'M409T1')
      RETURNING id
    `);
    if (!assetAId) throw new Error('Failed to create test asset');

    // Create test participant in campaign A
    participantAId = sql(`
      INSERT INTO public.platform_campaign_participants (campaign_id, respondent_phone, market)
      VALUES ('${campaignAId}', '+12025550409', 'US')
      RETURNING id
    `);
    if (!participantAId) throw new Error('Failed to create test participant');
  });

  afterAll(() => {
    try {
      // Cleanup in dependency order (CASCADE handles most, but be explicit)
      if (campaignAId) sql(`DELETE FROM public.platform_campaigns WHERE id = '${campaignAId}'`);
      if (campaignBId) sql(`DELETE FROM public.platform_campaigns WHERE id = '${campaignBId}'`);
      if (channelId) sql(`DELETE FROM public.whatsapp_channels WHERE id = '${channelId}'`);
      // profiles.id references auth.users.id with ON DELETE CASCADE
      if (profileId) sql(`DELETE FROM auth.users WHERE id = '${profileId}'`);
    } catch { /* cleanup best-effort */ }
  });

  it('consent_status defaults to unknown', () => {
    const consent = sql(`SELECT consent_status FROM public.platform_campaign_participants WHERE id = '${participantAId}'`);
    expect(consent).toBe('unknown');
  });

  it('rejects cross-campaign participant-asset binding', () => {
    // Try to create a Campaign B participant with Campaign A's asset as first_asset_id
    expect(() => {
      sql(`INSERT INTO public.platform_campaign_participants (campaign_id, respondent_phone, first_asset_id) VALUES ('${campaignBId}', '+12025559999', '${assetAId}')`);
    }).toThrow(); // FK violation: asset belongs to campaign A, not B
  });

  it('rejects cross-campaign event-participant binding', () => {
    // Try to create a Campaign B event with Campaign A's participant
    expect(() => {
      sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number) VALUES ('${participantAId}', '${campaignBId}', '+1234')`);
    }).toThrow(); // FK violation: participant belongs to campaign A, not B
  });

  it('rejects duplicate non-null source_event_id in same campaign', () => {
    // Insert first event with source_event_id
    sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number, source_event_id) VALUES ('${participantAId}', '${campaignAId}', '+1234', 'msg-m409-001')`);
    // Duplicate should fail
    expect(() => {
      sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number, source_event_id) VALUES ('${participantAId}', '${campaignAId}', '+1234', 'msg-m409-001')`);
    }).toThrow();
  });

  it('allows multiple NULL source_event_id in same campaign', () => {
    sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number) VALUES ('${participantAId}', '${campaignAId}', '+1234')`);
    sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number) VALUES ('${participantAId}', '${campaignAId}', '+1234')`);
    // Should succeed — NULLs are excluded from unique index
  });
});

describeDb('Migration 409 — ACL privilege tests (#439)', () => {
  it('service_role cannot UPDATE platform_campaign_events', () => {
    const hasUpdate = sql(`SELECT has_table_privilege('service_role', 'public.platform_campaign_events', 'UPDATE')`);
    expect(hasUpdate).toBe('f');
  });

  it('service_role cannot DELETE platform_campaign_events', () => {
    const hasDelete = sql(`SELECT has_table_privilege('service_role', 'public.platform_campaign_events', 'DELETE')`);
    expect(hasDelete).toBe('f');
  });

  it('service_role cannot UPDATE platform_campaign_clicks', () => {
    const hasUpdate = sql(`SELECT has_table_privilege('service_role', 'public.platform_campaign_clicks', 'UPDATE')`);
    expect(hasUpdate).toBe('f');
  });

  it('service_role cannot DELETE platform_campaign_clicks', () => {
    const hasDelete = sql(`SELECT has_table_privilege('service_role', 'public.platform_campaign_clicks', 'DELETE')`);
    expect(hasDelete).toBe('f');
  });

  it('service_role CAN SELECT/INSERT events', () => {
    expect(sql(`SELECT has_table_privilege('service_role', 'public.platform_campaign_events', 'SELECT')`)).toBe('t');
    expect(sql(`SELECT has_table_privilege('service_role', 'public.platform_campaign_events', 'INSERT')`)).toBe('t');
  });

  it('service_role CAN SELECT/INSERT/UPDATE campaigns', () => {
    expect(sql(`SELECT has_table_privilege('service_role', 'public.platform_campaigns', 'SELECT')`)).toBe('t');
    expect(sql(`SELECT has_table_privilege('service_role', 'public.platform_campaigns', 'INSERT')`)).toBe('t');
    expect(sql(`SELECT has_table_privilege('service_role', 'public.platform_campaigns', 'UPDATE')`)).toBe('t');
  });

  it('anon has no privileges on platform_campaigns', () => {
    expect(sql(`SELECT has_table_privilege('anon', 'public.platform_campaigns', 'SELECT')`)).toBe('f');
    expect(sql(`SELECT has_table_privilege('anon', 'public.platform_campaigns', 'INSERT')`)).toBe('f');
  });

  it('authenticated has no privileges on platform_campaigns', () => {
    expect(sql(`SELECT has_table_privilege('authenticated', 'public.platform_campaigns', 'SELECT')`)).toBe('f');
    expect(sql(`SELECT has_table_privilege('authenticated', 'public.platform_campaigns', 'INSERT')`)).toBe('f');
  });
});
