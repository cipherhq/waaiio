/**
 * Platform Campaigns Migration 409 — PostgreSQL constraint + ACL tests (#439)
 *
 * These tests run against a real PostgreSQL database with TEST_DATABASE_URL.
 * They create deterministic fixtures and verify constraints + ACL grants.
 *
 * IMPORTANT: This test must run early in CI — immediately after migration
 * application and basic verification, BEFORE mutation-heavy DB suites that
 * may contaminate the shared database's ACL state.
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
    // Use an existing profile from the CI seed or find one from migrations.
    // The CI seeds auth.users and the handle_new_user trigger auto-creates profiles.
    profileId = sql(`SELECT id FROM public.profiles LIMIT 1`);
    if (!profileId) {
      sql(`INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), 'test-m409-${Date.now()}@ci.local') ON CONFLICT DO NOTHING`);
      profileId = sql(`SELECT id FROM public.profiles LIMIT 1`);
    }
    if (!profileId) throw new Error('No profiles available in test DB');

    // Create a shared channel with unique phone number
    const uniquePhone = `+1409${Date.now() % 10000000}`;
    channelId = sql(`
      INSERT INTO public.whatsapp_channels (phone_number, country_code, channel_type, is_active, display_name)
      VALUES ('${uniquePhone}', 'US', 'shared', true, 'M409 CI Channel')
      RETURNING id
    `);
    if (!channelId) throw new Error('Failed to create test channel');

    // Create campaigns (consent_type is required, no default)
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

    assetAId = sql(`
      INSERT INTO public.platform_campaign_assets (campaign_id, source_type, market, channel_id, prefilled_message, attribution_token)
      VALUES ('${campaignAId}', 'website_button', 'US', '${channelId}', 'M409 test msg', 'M4${Date.now() % 10000}')
      RETURNING id
    `);
    if (!assetAId) throw new Error('Failed to create test asset');

    participantAId = sql(`
      INSERT INTO public.platform_campaign_participants (campaign_id, respondent_phone, market)
      VALUES ('${campaignAId}', '+1202555${Date.now() % 10000}', 'US')
      RETURNING id
    `);
    if (!participantAId) throw new Error('Failed to create test participant');
  });

  afterAll(() => {
    try {
      // CASCADE from campaigns handles assets, participants, events
      if (campaignAId) sql(`DELETE FROM public.platform_campaigns WHERE id = '${campaignAId}'`);
      if (campaignBId) sql(`DELETE FROM public.platform_campaigns WHERE id = '${campaignBId}'`);
      if (channelId) sql(`DELETE FROM public.whatsapp_channels WHERE id = '${channelId}'`);
    } catch { /* cleanup best-effort */ }
  });

  it('consent_status defaults to unknown', () => {
    const consent = sql(`SELECT consent_status FROM public.platform_campaign_participants WHERE id = '${participantAId}'`);
    expect(consent).toBe('unknown');
  });

  it('rejects cross-campaign participant-asset binding', () => {
    expect(() => {
      sql(`INSERT INTO public.platform_campaign_participants (campaign_id, respondent_phone, first_asset_id) VALUES ('${campaignBId}', '+12025559999', '${assetAId}')`);
    }).toThrow();
  });

  it('rejects cross-campaign event-participant binding', () => {
    expect(() => {
      sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number) VALUES ('${participantAId}', '${campaignBId}', '+1234')`);
    }).toThrow();
  });

  it('rejects duplicate non-null source_event_id in same campaign', () => {
    const eventId = `msg-m409-${Date.now()}`;
    sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number, source_event_id) VALUES ('${participantAId}', '${campaignAId}', '+1234', '${eventId}')`);
    expect(() => {
      sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number, source_event_id) VALUES ('${participantAId}', '${campaignAId}', '+1234', '${eventId}')`);
    }).toThrow();
  });

  it('allows multiple NULL source_event_id in same campaign', () => {
    sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number) VALUES ('${participantAId}', '${campaignAId}', '+1234')`);
    sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number) VALUES ('${participantAId}', '${campaignAId}', '+1234')`);
  });
});

describeDb('Migration 409 — ACL privilege tests (#439)', () => {
  it('service_role cannot UPDATE platform_campaign_events', () => {
    expect(sql(`SELECT has_table_privilege('service_role', 'public.platform_campaign_events', 'UPDATE')`)).toBe('f');
  });

  it('service_role cannot DELETE platform_campaign_events', () => {
    expect(sql(`SELECT has_table_privilege('service_role', 'public.platform_campaign_events', 'DELETE')`)).toBe('f');
  });

  it('service_role cannot UPDATE platform_campaign_clicks', () => {
    expect(sql(`SELECT has_table_privilege('service_role', 'public.platform_campaign_clicks', 'UPDATE')`)).toBe('f');
  });

  it('service_role cannot DELETE platform_campaign_clicks', () => {
    expect(sql(`SELECT has_table_privilege('service_role', 'public.platform_campaign_clicks', 'DELETE')`)).toBe('f');
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
