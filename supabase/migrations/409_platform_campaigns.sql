-- ═══════════════════════════════════════════════════════════
-- 409: Platform Communications foundation (#439 Slice 1)
--
-- Additive only. No existing table modified.
-- Five new tables: campaigns, assets, participants, events, clicks.
-- Two-level attribution: participants (canonical state) + events (immutable log).
-- Cross-campaign referential integrity via composite FKs.
-- Append-only authority on events/clicks (no UPDATE/DELETE grants).
-- ═══════════════════════════════════════════════════════════

-- ── 1. platform_campaigns ──

CREATE TABLE public.platform_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  campaign_type   TEXT NOT NULL CHECK (campaign_type IN (
    'opt_in', 'waitlist', 'survey', 'feedback', 'event_interest',
    'data_collection', 'notification', 'broadcast'
  )),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'active', 'paused', 'completed', 'archived'
  )),
  market_scope    TEXT[] NOT NULL DEFAULT '{}',
  message_config  JSONB NOT NULL DEFAULT '{}',
  consent_type    TEXT NOT NULL CHECK (consent_type IN (
    'opt_in', 'informational', 'transactional'
  )),
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  created_by      UUID NOT NULL REFERENCES public.profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- created_by convention: Admin API uses requirePlatformAdmin().userId.
-- The on_auth_user_created trigger auto-creates a profiles row for every
-- auth user. Consistent with admin_audit_logs.actor_id REFERENCES profiles(id).
-- If profile creation drifted, campaign creation fails closed via FK violation.

CREATE INDEX idx_pc_status ON public.platform_campaigns(status);
CREATE INDEX idx_pc_type ON public.platform_campaigns(campaign_type);

-- ── 2. platform_campaign_assets ──

CREATE TABLE public.platform_campaign_assets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID NOT NULL REFERENCES public.platform_campaigns(id) ON DELETE CASCADE,
  source_type       TEXT NOT NULL CHECK (source_type IN (
    'website_button', 'website_qr', 'instagram_link', 'instagram_qr',
    'billboard_qr', 'flyer_qr', 'event_qr', 'direct_link', 'email_link', 'other'
  )),
  source_label      TEXT,
  market            VARCHAR(4) NOT NULL,
  channel_id        UUID NOT NULL REFERENCES public.whatsapp_channels(id),
  prefilled_message TEXT NOT NULL,
  attribution_token TEXT NOT NULL UNIQUE,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Composite unique for cross-campaign FK targets
  UNIQUE (id, campaign_id)
);

-- NOTE: No generated_link or redirect_path stored. wa.me URL is derived
-- server-side at redirect time. Canonical redirect: /go/<attribution_token>.
-- Market is server-derived from channel's country_code, not caller-supplied.

CREATE INDEX idx_pca_campaign ON public.platform_campaign_assets(campaign_id);

-- ── 3. platform_campaign_participants (canonical state) ──

CREATE TABLE public.platform_campaign_participants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES public.platform_campaigns(id) ON DELETE CASCADE,
  respondent_phone    TEXT NOT NULL,
  consent_status      TEXT NOT NULL DEFAULT 'unknown' CHECK (consent_status IN (
    'unknown', 'opted_in', 'opted_out'
  )),
  response_data       JSONB DEFAULT '{}',
  first_asset_id      UUID,
  last_asset_id       UUID,
  first_channel_id    UUID REFERENCES public.whatsapp_channels(id),
  last_channel_id     UUID REFERENCES public.whatsapp_channels(id),
  market              VARCHAR(4),
  first_response_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  latest_response_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (campaign_id, respondent_phone),
  -- Composite unique for cross-campaign FK targets
  UNIQUE (id, campaign_id),
  -- Composite FKs ensure assets belong to the same campaign
  FOREIGN KEY (first_asset_id, campaign_id) REFERENCES public.platform_campaign_assets(id, campaign_id),
  FOREIGN KEY (last_asset_id, campaign_id) REFERENCES public.platform_campaign_assets(id, campaign_id)
);

-- consent_status rules:
--   'unknown'   = participated (e.g. survey answer) but no explicit consent
--   'opted_in'  = explicit opt-in campaign response (e.g. "Notify me")
--   'opted_out' = STOP or explicit unsubscribe
-- Ordinary survey/data-collection participation does NOT become marketing consent.

CREATE INDEX idx_pcp_campaign ON public.platform_campaign_participants(campaign_id);
CREATE INDEX idx_pcp_phone ON public.platform_campaign_participants(respondent_phone);
CREATE INDEX idx_pcp_market ON public.platform_campaign_participants(market);

-- ── 4. platform_campaign_events (immutable per-interaction log) ──

CREATE TABLE public.platform_campaign_events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id       UUID NOT NULL,
  campaign_id          UUID NOT NULL,
  asset_id             UUID,
  receiving_channel_id UUID REFERENCES public.whatsapp_channels(id),
  receiving_number     TEXT NOT NULL,
  market               VARCHAR(4),
  event_type           TEXT NOT NULL DEFAULT 'response' CHECK (event_type IN (
    'response', 'opt_in', 'opt_out', 'data_answer'
  )),
  event_data           JSONB DEFAULT '{}',
  source_event_id      TEXT,
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Composite FK: participant must belong to the same campaign
  FOREIGN KEY (participant_id, campaign_id)
    REFERENCES public.platform_campaign_participants(id, campaign_id) ON DELETE CASCADE,
  -- Composite FK: asset must belong to the same campaign (when present)
  FOREIGN KEY (asset_id, campaign_id)
    REFERENCES public.platform_campaign_assets(id, campaign_id)
);

-- Inbound-event idempotency: prevent duplicate source events
CREATE UNIQUE INDEX idx_pce_source_event_idempotency
  ON public.platform_campaign_events(campaign_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE INDEX idx_pce_participant ON public.platform_campaign_events(participant_id);
CREATE INDEX idx_pce_campaign ON public.platform_campaign_events(campaign_id);
CREATE INDEX idx_pce_asset ON public.platform_campaign_events(asset_id);
CREATE INDEX idx_pce_occurred ON public.platform_campaign_events(occurred_at);

-- ── 5. platform_campaign_clicks (tracked redirect analytics) ──

CREATE TABLE public.platform_campaign_clicks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    UUID NOT NULL REFERENCES public.platform_campaign_assets(id) ON DELETE CASCADE,
  clicked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent  VARCHAR(512),
  referrer    VARCHAR(512)
);

CREATE INDEX idx_pcc_asset ON public.platform_campaign_clicks(asset_id);
CREATE INDEX idx_pcc_time ON public.platform_campaign_clicks(clicked_at);

-- ═══════════════════════════════════════════════════════════
-- RLS
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.platform_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_campaign_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_campaign_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_campaign_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_campaign_clicks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_all_platform_campaigns"
  ON public.platform_campaigns FOR ALL USING (public.is_admin());
CREATE POLICY "admin_all_platform_campaign_assets"
  ON public.platform_campaign_assets FOR ALL USING (public.is_admin());
CREATE POLICY "admin_all_platform_campaign_participants"
  ON public.platform_campaign_participants FOR ALL USING (public.is_admin());
CREATE POLICY "admin_all_platform_campaign_events"
  ON public.platform_campaign_events FOR ALL USING (public.is_admin());
CREATE POLICY "admin_all_platform_campaign_clicks"
  ON public.platform_campaign_clicks FOR ALL USING (public.is_admin());

-- ═══════════════════════════════════════════════════════════
-- ACL — least-privilege grants
-- ═══════════════════════════════════════════════════════════

-- Deterministic ACL: revoke everything first, then grant exact intended privileges.
-- Includes service_role to clear any default privileges before narrowing.
REVOKE ALL ON public.platform_campaigns FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.platform_campaign_assets FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.platform_campaign_participants FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.platform_campaign_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.platform_campaign_clicks FROM PUBLIC, anon, authenticated, service_role;

-- service_role: campaigns/assets/participants get SELECT/INSERT/UPDATE (no DELETE)
GRANT SELECT, INSERT, UPDATE ON public.platform_campaigns TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.platform_campaign_assets TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.platform_campaign_participants TO service_role;

-- service_role: events/clicks are append-only (SELECT/INSERT only, no UPDATE/DELETE)
GRANT SELECT, INSERT ON public.platform_campaign_events TO service_role;
GRANT SELECT, INSERT ON public.platform_campaign_clicks TO service_role;
