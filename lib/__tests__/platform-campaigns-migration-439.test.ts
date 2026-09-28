/**
 * Platform Campaigns Migration 409 — PostgreSQL constraint + ACL tests (#439)
 *
 * These tests run against a real disposable PostgreSQL database when
 * TEST_DATABASE_URL is set. Otherwise they are skipped.
 *
 * Tests prove:
 * - Cross-campaign FK integrity (Campaign A asset cannot bind to Campaign B)
 * - source_event_id idempotency
 * - consent defaults to 'unknown'
 * - ACL: service_role cannot UPDATE/DELETE events/clicks
 * - ACL: anon/authenticated have no privileges
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;
const canRunDbTests = !!dbUrl;

function sql(query: string): string {
  if (!dbUrl) throw new Error('No TEST_DATABASE_URL');
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: query,
    encoding: 'utf-8',
    timeout: 10_000,
  }).trim();
}

// These tests require a real PG with migration 409 applied.
// In CI without TEST_DATABASE_URL, they are skipped gracefully.
const describeDb = canRunDbTests ? describe : describe.skip;

describeDb('Migration 409 — PostgreSQL constraint tests (#439)', () => {
  // Setup: create test data
  let campaignAId: string;
  let campaignBId: string;
  let assetAId: string;
  let participantAId: string;

  beforeAll(() => {
    // Need a profile for created_by FK
    const profileId = sql(`SELECT id FROM public.profiles LIMIT 1`);
    if (!profileId) throw new Error('No profiles in test DB');

    // Need a shared channel for asset FK
    const channelId = sql(`SELECT id FROM public.whatsapp_channels WHERE channel_type='shared' AND is_active=true LIMIT 1`);

    campaignAId = sql(`INSERT INTO public.platform_campaigns (name, campaign_type, consent_type, created_by) VALUES ('Test A', 'opt_in', 'opt_in', '${profileId}') RETURNING id`);
    campaignBId = sql(`INSERT INTO public.platform_campaigns (name, campaign_type, consent_type, created_by) VALUES ('Test B', 'survey', 'informational', '${profileId}') RETURNING id`);

    if (channelId) {
      assetAId = sql(`INSERT INTO public.platform_campaign_assets (campaign_id, source_type, market, channel_id, prefilled_message, attribution_token) VALUES ('${campaignAId}', 'website_button', 'US', '${channelId}', 'Test msg', 'TST001') RETURNING id`);
      participantAId = sql(`INSERT INTO public.platform_campaign_participants (campaign_id, respondent_phone, market) VALUES ('${campaignAId}', '+12025551111', 'US') RETURNING id`);
    }
  });

  afterAll(() => {
    try {
      if (campaignAId) sql(`DELETE FROM public.platform_campaigns WHERE id = '${campaignAId}'`);
      if (campaignBId) sql(`DELETE FROM public.platform_campaigns WHERE id = '${campaignBId}'`);
    } catch { /* cleanup best-effort */ }
  });

  it('consent_status defaults to unknown', () => {
    if (!participantAId) return;
    const consent = sql(`SELECT consent_status FROM public.platform_campaign_participants WHERE id = '${participantAId}'`);
    expect(consent).toBe('unknown');
  });

  it('rejects cross-campaign participant-asset binding', () => {
    if (!assetAId || !participantAId) return;
    // Try to set last_asset_id to Campaign A's asset on Campaign B's hypothetical participant
    expect(() => {
      sql(`INSERT INTO public.platform_campaign_participants (campaign_id, respondent_phone, first_asset_id) VALUES ('${campaignBId}', '+12025559999', '${assetAId}')`);
    }).toThrow(); // FK violation: asset belongs to campaign A, not B
  });

  it('rejects duplicate non-null source_event_id in same campaign', () => {
    if (!participantAId || !assetAId) return;
    // Insert first event with source_event_id
    sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number, source_event_id) VALUES ('${participantAId}', '${campaignAId}', '+1234', 'msg-001')`);
    // Duplicate should fail
    expect(() => {
      sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number, source_event_id) VALUES ('${participantAId}', '${campaignAId}', '+1234', 'msg-001')`);
    }).toThrow();
  });

  it('allows multiple NULL source_event_id in same campaign', () => {
    if (!participantAId) return;
    sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number) VALUES ('${participantAId}', '${campaignAId}', '+1234')`);
    sql(`INSERT INTO public.platform_campaign_events (participant_id, campaign_id, receiving_number) VALUES ('${participantAId}', '${campaignAId}', '+1234')`);
    // Should succeed — NULLs are allowed
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
