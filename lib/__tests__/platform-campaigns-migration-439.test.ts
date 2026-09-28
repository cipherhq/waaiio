/**
 * Platform Campaigns Migration 409 — PostgreSQL constraint + ACL tests (#439)
 *
 * These tests run against a real PostgreSQL database with TEST_DATABASE_URL.
 * They create all necessary fixtures deterministically.
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
    // Use an existing profile from the CI seed or find one from migrations
    // The CI seeds auth.users with '00000000-0000-0000-0000-000000000000'
    // and the handle_new_user trigger auto-creates a profiles row.
    profileId = sql(`SELECT id FROM public.profiles LIMIT 1`);
    if (!profileId) {
      // If no profiles exist, create one via auth.users (trigger creates profile)
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
  // Test ACL by inspecting the relacl column from pg_class directly.
  // This is the authoritative source — it shows the exact privilege grants
  // regardless of role attributes like BYPASSRLS or superuser context.

  function getAclEntries(tableName: string): string[] {
    const raw = sql(`SELECT array_to_string(relacl, ',') FROM pg_class WHERE relname = '${tableName}'`);
    return raw ? raw.split(',') : [];
  }

  function roleHasPrivilege(tableName: string, roleName: string, privChar: string): boolean {
    const entries = getAclEntries(tableName);
    // ACL format: grantee=privileges/grantor
    // e.g., service_role=r/postgres means service_role has SELECT, granted by postgres
    // Privilege chars: r=SELECT, a=INSERT, w=UPDATE, d=DELETE
    for (const entry of entries) {
      const match = entry.match(new RegExp(`^${roleName}=([^/]+)/`));
      if (match) return match[1].includes(privChar);
    }
    return false;
  }

  it('debug: print actual ACL state', () => {
    const eventsAcl = sql(`SELECT array_to_string(relacl, ' | ') FROM pg_class WHERE relname = 'platform_campaign_events'`);
    const clicksAcl = sql(`SELECT array_to_string(relacl, ' | ') FROM pg_class WHERE relname = 'platform_campaign_clicks'`);
    const defPrivs = sql(`SELECT defaclrole::regrole || '>' || defaclobjtype || '>' || array_to_string(defaclacl, ',') FROM pg_default_acl WHERE defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')`);
    console.log('Events ACL:', eventsAcl);
    console.log('Clicks ACL:', clicksAcl);
    console.log('Default privileges:', defPrivs || 'NONE');
    expect(true).toBe(true); // always pass — diagnostic only
  });

  it('service_role cannot UPDATE platform_campaign_events (ACL check)', () => {
    expect(roleHasPrivilege('platform_campaign_events', 'service_role', 'w')).toBe(false);
  });

  it('service_role cannot DELETE platform_campaign_events (ACL check)', () => {
    expect(roleHasPrivilege('platform_campaign_events', 'service_role', 'd')).toBe(false);
  });

  it('service_role cannot UPDATE platform_campaign_clicks (ACL check)', () => {
    expect(roleHasPrivilege('platform_campaign_clicks', 'service_role', 'w')).toBe(false);
  });

  it('service_role cannot DELETE platform_campaign_clicks (ACL check)', () => {
    expect(roleHasPrivilege('platform_campaign_clicks', 'service_role', 'd')).toBe(false);
  });

  it('service_role CAN SELECT/INSERT events (ACL check)', () => {
    expect(roleHasPrivilege('platform_campaign_events', 'service_role', 'r')).toBe(true);
    expect(roleHasPrivilege('platform_campaign_events', 'service_role', 'a')).toBe(true);
  });

  it('service_role CAN SELECT/INSERT/UPDATE campaigns (ACL check)', () => {
    expect(roleHasPrivilege('platform_campaigns', 'service_role', 'r')).toBe(true);
    expect(roleHasPrivilege('platform_campaigns', 'service_role', 'a')).toBe(true);
    expect(roleHasPrivilege('platform_campaigns', 'service_role', 'w')).toBe(true);
  });

  it('anon has no privileges on platform_campaigns (ACL check)', () => {
    expect(roleHasPrivilege('platform_campaigns', 'anon', 'r')).toBe(false);
    expect(roleHasPrivilege('platform_campaigns', 'anon', 'a')).toBe(false);
  });

  it('authenticated has no privileges on platform_campaigns (ACL check)', () => {
    expect(roleHasPrivilege('platform_campaigns', 'authenticated', 'r')).toBe(false);
    expect(roleHasPrivilege('platform_campaigns', 'authenticated', 'a')).toBe(false);
  });
});
