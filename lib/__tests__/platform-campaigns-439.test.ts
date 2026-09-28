/**
 * Platform Campaigns Slice 1 — #439
 *
 * Tests: token generation, redirect fail-closed, migration structure,
 * cross-campaign FK constraints, consent semantics, ACL/grants,
 * market validation contract, append-only events/clicks authority.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  generateAttributionToken,
  buildTrackedMessage,
  extractRefToken,
  TOKEN_ALPHABET,
  TOKEN_LENGTH,
  MAX_RETRIES,
} from '@/lib/platform-campaigns/token';

const ROOT = path.resolve(__dirname, '../..');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/409_platform_campaigns.sql'),
  'utf-8',
);

// ═══════════════════════════════════════════════════
// Token generation
// ═══════════════════════════════════════════════════

describe('Attribution token generation (#439)', () => {
  it('generates a 6-character uppercase token', () => {
    const token = generateAttributionToken();
    expect(token).toHaveLength(TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('uses only characters from the safe alphabet (no 0/O/1/I)', () => {
    // Generate many tokens and verify no ambiguous chars
    for (let i = 0; i < 100; i++) {
      const token = generateAttributionToken();
      expect(token).not.toMatch(/[01OI]/);
      for (const ch of token) {
        expect(TOKEN_ALPHABET).toContain(ch);
      }
    }
  });

  it('generates unique tokens (100 tokens, no collision)', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateAttributionToken());
    }
    // With 32^6 = 1B possibilities, 100 tokens should be unique
    expect(tokens.size).toBe(100);
  });

  it('MAX_RETRIES is bounded', () => {
    expect(MAX_RETRIES).toBe(5);
  });

  it('alphabet has exactly 32 chars (256 divides evenly, zero modulo bias)', () => {
    expect(TOKEN_ALPHABET).toHaveLength(32);
    expect(256 % TOKEN_ALPHABET.length).toBe(0);
  });
});

describe('Tracked message construction (#439)', () => {
  it('appends Ref token to prefilled message', () => {
    const msg = buildTrackedMessage('Notify me when Waaiio launches', 'L7K2QX');
    expect(msg).toBe('Notify me when Waaiio launches — Ref: L7K2QX');
  });

  it('trims whitespace from prefilled message', () => {
    const msg = buildTrackedMessage('  Hello  ', 'ABC234');
    expect(msg).toBe('Hello — Ref: ABC234');
  });
});

describe('Ref token extraction (#439)', () => {
  it('extracts token from tracked message', () => {
    expect(extractRefToken('Notify me when Waaiio launches — Ref: L7K2QX')).toBe('L7K2QX');
  });

  it('normalizes lowercase to uppercase', () => {
    expect(extractRefToken('Hello — Ref: abc234')).toBe('ABC234');
  });

  it('returns null when no ref token present', () => {
    expect(extractRefToken('Hello, I want to book')).toBeNull();
  });

  it('returns null for partial/short tokens', () => {
    expect(extractRefToken('Ref: AB')).toBeNull();
  });

  it('handles ref token with extra whitespace', () => {
    expect(extractRefToken('Message — Ref:  X2Y3Z4')).toBe('X2Y3Z4');
  });
});

// ═══════════════════════════════════════════════════
// Migration structure — schema contracts
// ═══════════════════════════════════════════════════

describe('Migration 409 — schema structure (#439)', () => {
  it('creates all 5 tables', () => {
    expect(MIGRATION).toContain('CREATE TABLE public.platform_campaigns');
    expect(MIGRATION).toContain('CREATE TABLE public.platform_campaign_assets');
    expect(MIGRATION).toContain('CREATE TABLE public.platform_campaign_participants');
    expect(MIGRATION).toContain('CREATE TABLE public.platform_campaign_events');
    expect(MIGRATION).toContain('CREATE TABLE public.platform_campaign_clicks');
  });

  it('does NOT modify any existing table', () => {
    expect(MIGRATION).not.toMatch(/ALTER TABLE public\.(launch_subscribers|admin_broadcasts|keyword_campaigns|notifications|messaging_opt_outs|businesses|profiles|whatsapp_channels)/);
  });
});

describe('Migration 409 — consent semantics (#439)', () => {
  it('uses consent_status NOT opt_in_status on participants', () => {
    // Participants should have consent_status, not opt_in_status
    expect(MIGRATION).toContain('consent_status');
    // The participants table must not use opt_in_status
    const participantsBlock = MIGRATION.slice(
      MIGRATION.indexOf('platform_campaign_participants'),
      MIGRATION.indexOf('platform_campaign_events'),
    );
    expect(participantsBlock).not.toContain('opt_in_status');
  });

  it('consent defaults to unknown, not active/opted_in', () => {
    expect(MIGRATION).toContain("DEFAULT 'unknown'");
    expect(MIGRATION).toContain("'unknown', 'opted_in', 'opted_out'");
  });
});

describe('Migration 409 — cross-campaign referential integrity (#439)', () => {
  it('assets have composite UNIQUE (id, campaign_id) for FK targets', () => {
    expect(MIGRATION).toMatch(/UNIQUE\s*\(id,\s*campaign_id\)/);
  });

  it('participants have composite UNIQUE (id, campaign_id)', () => {
    const participantsBlock = MIGRATION.slice(
      MIGRATION.indexOf('platform_campaign_participants'),
      MIGRATION.indexOf('platform_campaign_events'),
    );
    expect(participantsBlock).toMatch(/UNIQUE\s*\(id,\s*campaign_id\)/);
  });

  it('participant asset FKs use composite (asset_id, campaign_id)', () => {
    expect(MIGRATION).toContain('FOREIGN KEY (first_asset_id, campaign_id) REFERENCES public.platform_campaign_assets(id, campaign_id)');
    expect(MIGRATION).toContain('FOREIGN KEY (last_asset_id, campaign_id) REFERENCES public.platform_campaign_assets(id, campaign_id)');
  });

  it('event participant FK uses composite (participant_id, campaign_id)', () => {
    expect(MIGRATION).toContain('FOREIGN KEY (participant_id, campaign_id)');
    expect(MIGRATION).toContain('REFERENCES public.platform_campaign_participants(id, campaign_id)');
  });

  it('event asset FK uses composite (asset_id, campaign_id)', () => {
    expect(MIGRATION).toMatch(/FOREIGN KEY \(asset_id, campaign_id\)\s*\n\s*REFERENCES public\.platform_campaign_assets\(id, campaign_id\)/);
  });
});

describe('Migration 409 — inbound-event idempotency (#439)', () => {
  it('events have source_event_id column', () => {
    expect(MIGRATION).toContain('source_event_id');
  });

  it('has partial unique index on (campaign_id, source_event_id) where not null', () => {
    expect(MIGRATION).toContain('idx_pce_source_event_idempotency');
    expect(MIGRATION).toContain('WHERE source_event_id IS NOT NULL');
  });
});

describe('Migration 409 — ACL/grants least privilege (#439)', () => {
  it('REVOKEs from PUBLIC, anon, authenticated', () => {
    expect(MIGRATION).toContain('REVOKE ALL ON public.platform_campaigns FROM PUBLIC, anon, authenticated');
    expect(MIGRATION).toContain('REVOKE ALL ON public.platform_campaign_events FROM PUBLIC, anon, authenticated');
    expect(MIGRATION).toContain('REVOKE ALL ON public.platform_campaign_clicks FROM PUBLIC, anon, authenticated');
  });

  it('events get SELECT/INSERT only (append-only, no UPDATE/DELETE)', () => {
    expect(MIGRATION).toContain('GRANT SELECT, INSERT ON public.platform_campaign_events TO service_role');
    // Must NOT grant UPDATE or DELETE on events
    expect(MIGRATION).not.toMatch(/GRANT.*UPDATE.*ON public\.platform_campaign_events/);
    expect(MIGRATION).not.toMatch(/GRANT.*DELETE.*ON public\.platform_campaign_events/);
    expect(MIGRATION).not.toMatch(/GRANT ALL ON public\.platform_campaign_events/);
  });

  it('clicks get SELECT/INSERT only (append-only)', () => {
    expect(MIGRATION).toContain('GRANT SELECT, INSERT ON public.platform_campaign_clicks TO service_role');
    expect(MIGRATION).not.toMatch(/GRANT ALL ON public\.platform_campaign_clicks/);
  });

  it('campaigns/assets/participants get SELECT/INSERT/UPDATE (no DELETE)', () => {
    expect(MIGRATION).toContain('GRANT SELECT, INSERT, UPDATE ON public.platform_campaigns TO service_role');
    expect(MIGRATION).toContain('GRANT SELECT, INSERT, UPDATE ON public.platform_campaign_assets TO service_role');
    expect(MIGRATION).toContain('GRANT SELECT, INSERT, UPDATE ON public.platform_campaign_participants TO service_role');
  });

  it('enables RLS on all 5 tables', () => {
    expect(MIGRATION).toContain('ALTER TABLE public.platform_campaigns ENABLE ROW LEVEL SECURITY');
    expect(MIGRATION).toContain('ALTER TABLE public.platform_campaign_assets ENABLE ROW LEVEL SECURITY');
    expect(MIGRATION).toContain('ALTER TABLE public.platform_campaign_participants ENABLE ROW LEVEL SECURITY');
    expect(MIGRATION).toContain('ALTER TABLE public.platform_campaign_events ENABLE ROW LEVEL SECURITY');
    expect(MIGRATION).toContain('ALTER TABLE public.platform_campaign_clicks ENABLE ROW LEVEL SECURITY');
  });
});

describe('Migration 409 — no stored redirect or wa.me URL (#439)', () => {
  it('assets CREATE TABLE does NOT have generated_link column', () => {
    // Extract just the CREATE TABLE statement for assets
    const createStart = MIGRATION.indexOf('CREATE TABLE public.platform_campaign_assets');
    const createEnd = MIGRATION.indexOf(');', createStart) + 2;
    const createStmt = MIGRATION.slice(createStart, createEnd);
    expect(createStmt).not.toMatch(/^\s+generated_link/m);
  });

  it('assets CREATE TABLE does NOT have redirect_path column', () => {
    const createStart = MIGRATION.indexOf('CREATE TABLE public.platform_campaign_assets');
    const createEnd = MIGRATION.indexOf(');', createStart) + 2;
    const createStmt = MIGRATION.slice(createStart, createEnd);
    expect(createStmt).not.toMatch(/^\s+redirect_path/m);
  });
});

describe('Migration 409 — no duplicate unique index on attribution_token (#439)', () => {
  it('has UNIQUE constraint on attribution_token', () => {
    expect(MIGRATION).toContain('attribution_token TEXT NOT NULL UNIQUE');
  });

  it('does NOT create a separate unique index on attribution_token', () => {
    expect(MIGRATION).not.toMatch(/CREATE UNIQUE INDEX.*attribution_token/);
  });
});

describe('Migration 409 — click metadata bounded (#439)', () => {
  it('user_agent is VARCHAR(512)', () => {
    expect(MIGRATION).toContain('user_agent  VARCHAR(512)');
  });

  it('referrer is VARCHAR(512)', () => {
    expect(MIGRATION).toContain('referrer    VARCHAR(512)');
  });

  it('does NOT have ip_hash', () => {
    expect(MIGRATION).not.toContain('ip_hash');
  });
});

// ═══════════════════════════════════════════════════
// Redirect route — fail-closed contracts
// ═══════════════════════════════════════════════════

describe('Redirect route /go/[token] — structure (#439)', () => {
  const redirectSrc = fs.readFileSync(
    path.join(ROOT, 'app/go/[token]/route.ts'),
    'utf-8',
  );

  it('uses createServiceClient, not createClient', () => {
    expect(redirectSrc).toContain('createServiceClient');
    expect(redirectSrc).not.toContain("from '@/lib/supabase/client'");
    expect(redirectSrc).not.toContain("from '@/lib/supabase/server'");
  });

  it('validates token shape with regex', () => {
    expect(redirectSrc).toMatch(/A-Z0-9/);
    expect(redirectSrc).toContain('{6}');
  });

  it('checks asset is_active', () => {
    expect(redirectSrc).toContain('is_active');
  });

  it('checks campaign status is active', () => {
    expect(redirectSrc).toContain("status !== 'active'");
  });

  it('validates campaign timing (starts_at / ends_at)', () => {
    expect(redirectSrc).toContain('starts_at');
    expect(redirectSrc).toContain('ends_at');
  });

  it('validates channel_type is shared and is_active', () => {
    expect(redirectSrc).toContain("channel_type !== 'shared'");
    expect(redirectSrc).toContain('is_active');
  });

  it('derives wa.me URL server-side via buildTrackedMessage', () => {
    expect(redirectSrc).toContain('buildTrackedMessage');
    expect(redirectSrc).toContain('wa.me');
  });

  it('records click best-effort (fire-and-forget)', () => {
    expect(redirectSrc).toContain('platform_campaign_clicks');
    expect(redirectSrc).toContain('.then(() => {}, () => {})');
  });

  it('truncates user_agent and referrer to 512 chars', () => {
    expect(redirectSrc).toContain('.slice(0, 512)');
  });

  it('returns 404 on any authority failure (fail closed)', () => {
    const notFoundCount = (redirectSrc.match(/status: 404/g) || []).length;
    // At least 4: invalid token, inactive asset, inactive campaign, bad channel
    expect(notFoundCount).toBeGreaterThanOrEqual(4);
  });

  it('uses rate limiting', () => {
    expect(redirectSrc).toContain('rateLimitResponseAsync');
  });

  it('does NOT accept arbitrary redirect URL from request', () => {
    // redirect target is always the derived wa.me URL, never from params/body
    expect(redirectSrc).not.toContain('request.url');
    expect(redirectSrc).toContain('NextResponse.redirect(waUrl');
  });
});

// ═══════════════════════════════════════════════════
// Asset creation — shared-channel authority
// ═══════════════════════════════════════════════════

describe('Asset creation route — authority contracts (#439)', () => {
  const assetRouteSrc = fs.readFileSync(
    path.join(ROOT, 'app/api/admin/platform-campaigns/[id]/assets/route.ts'),
    'utf-8',
  );

  it('requires platform admin', () => {
    expect(assetRouteSrc).toContain("requirePlatformAdmin(request, { requiredRole: 'admin' })");
  });

  it('validates channel_type is shared', () => {
    expect(assetRouteSrc).toContain("channel.channel_type !== 'shared'");
  });

  it('validates channel is active', () => {
    expect(assetRouteSrc).toContain("channel.is_active");
  });

  it('server-derives market from channel country_code', () => {
    expect(assetRouteSrc).toContain('channel.country_code');
    expect(assetRouteSrc).toContain('const market = channel.country_code');
  });

  it('validates market is within campaign market_scope', () => {
    expect(assetRouteSrc).toContain('market_scope');
    expect(assetRouteSrc).toContain('scope.includes(market)');
  });

  it('retries on token collision', () => {
    expect(assetRouteSrc).toContain('MAX_TOKEN_RETRIES');
    expect(assetRouteSrc).toContain('23505');
  });

  it('writes audit log', () => {
    expect(assetRouteSrc).toContain('admin_audit_logs');
    expect(assetRouteSrc).toContain('platform_campaign_asset_created');
  });

  it('does NOT expose a DELETE endpoint', () => {
    expect(assetRouteSrc).not.toMatch(/export\s+async\s+function\s+DELETE/);
  });
});

// ═══════════════════════════════════════════════════
// Existing flows untouched
// ═══════════════════════════════════════════════════

describe('Existing flows untouched by Slice 1 (#439)', () => {
  it('launch-optin.ts not modified from main', () => {
    // The file should exist and not import platform-campaigns
    const src = fs.readFileSync(path.join(ROOT, 'lib/bot/launch-optin.ts'), 'utf-8');
    expect(src).not.toContain('platform_campaign');
    expect(src).toContain('launch_subscribers');
  });

  it('launch delivery.ts does not import platform-campaigns', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/launch/delivery.ts'), 'utf-8');
    expect(src).not.toContain('platform_campaign');
  });

  it('business broadcasts route unchanged', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/api/broadcasts/send/route.ts'), 'utf-8');
    expect(src).not.toContain('platform_campaign');
  });
});
