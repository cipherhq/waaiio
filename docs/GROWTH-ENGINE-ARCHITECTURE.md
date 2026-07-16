# Growth Engine — Architecture & Implementation Plan

## Product Summary

The Growth Engine enables businesses to acquire new WhatsApp customers compliantly. Instead of "how do I send cold messages?", businesses think "how do I get more customers onto WhatsApp?"

## Architecture

```
Contact Import (CSV/Excel)
        ↓
Validation (phone, country, dedup)
        ↓
Consent Engine (grant/revoke/verify)
        ↓
Eligibility Service (per customer)
        ↓
Channel Decision Engine
        ├── WhatsApp Template (has consent + template approved)
        ├── SMS Invite (needs consent, has phone)
        ├── Email Invite (needs consent, has email)
        ├── QR Campaign (passive acquisition)
        └── Landing Page / Referral
        ↓
Customer opens WhatsApp → Waaiio AI → Book/Order/Pay
        ↓
Attribution tracking (import → invite → conversation → revenue)
```

## Database Schema

### New Tables

#### `growth_contacts`
Imported contacts for a business. Separate from customer_profiles (which are WhatsApp-active).

```sql
id UUID PK
business_id UUID FK → businesses
first_name TEXT
last_name TEXT
phone TEXT NOT NULL
email TEXT
country_code TEXT
birthday DATE
tags TEXT[]
custom_fields JSONB DEFAULT '{}'
import_id UUID FK → growth_imports
source TEXT  -- csv, excel, manual, api
status TEXT  -- active, invalid, duplicate, opted_out
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
UNIQUE(business_id, phone)
```

#### `growth_imports`
Track each import batch.

```sql
id UUID PK
business_id UUID FK → businesses
filename TEXT
total_rows INTEGER
valid_rows INTEGER
duplicate_rows INTEGER
invalid_rows INTEGER
status TEXT  -- processing, completed, failed
field_mapping JSONB  -- maps CSV columns to fields
created_by UUID FK → auth.users
created_at TIMESTAMPTZ
completed_at TIMESTAMPTZ
```

#### `customer_consents`
The consent ledger — append-only for audit.

```sql
id UUID PK
business_id UUID FK → businesses
phone TEXT NOT NULL
channel TEXT CHECK (channel IN ('whatsapp', 'sms', 'email'))
purpose TEXT CHECK (purpose IN ('utility', 'marketing', 'authentication'))
status TEXT CHECK (status IN ('granted', 'revoked', 'pending', 'unknown'))
source TEXT CHECK (source IN ('website', 'checkout', 'qr', 'pos', 'event', 'paper', 'crm_import', 'manual', 'sms', 'whatsapp', 'api'))
evidence_reference TEXT
policy_version TEXT
granted_at TIMESTAMPTZ
expires_at TIMESTAMPTZ
revoked_at TIMESTAMPTZ
created_by UUID FK → auth.users
created_at TIMESTAMPTZ
```

#### `growth_campaigns`
Acquisition campaigns (distinct from broadcast campaigns).

```sql
id UUID PK
business_id UUID FK → businesses
name TEXT NOT NULL
type TEXT  -- sms_invite, whatsapp_template, email_invite
status TEXT  -- draft, scheduled, sending, completed, cancelled
template_id TEXT  -- Meta template name
target_segment JSONB  -- filter criteria
total_recipients INTEGER
credits_reserved INTEGER
credits_consumed INTEGER
scheduled_at TIMESTAMPTZ
started_at TIMESTAMPTZ
completed_at TIMESTAMPTZ
created_by UUID FK → auth.users
created_at TIMESTAMPTZ
```

#### `growth_campaign_recipients`
Per-recipient tracking for attribution.

```sql
id UUID PK
campaign_id UUID FK → growth_campaigns
contact_id UUID FK → growth_contacts
phone TEXT
channel TEXT  -- sms, whatsapp, email
status TEXT  -- pending, sent, delivered, clicked, converted, failed, opted_out
credits_used INTEGER DEFAULT 0
sent_at TIMESTAMPTZ
delivered_at TIMESTAMPTZ
clicked_at TIMESTAMPTZ
converted_at TIMESTAMPTZ
error_message TEXT
created_at TIMESTAMPTZ
```

#### `growth_credits`
Credit balance tracking per business.

```sql
id UUID PK
business_id UUID FK → businesses
type TEXT  -- included, purchased, promotional
amount INTEGER NOT NULL
remaining INTEGER NOT NULL
source TEXT  -- subscription, topup, promo
reference TEXT
expires_at TIMESTAMPTZ
created_at TIMESTAMPTZ
UNIQUE(business_id, type, reference)
```

#### `growth_credit_transactions`
Credit movement ledger.

```sql
id UUID PK
business_id UUID FK → businesses
credit_id UUID FK → growth_credits
campaign_id UUID FK → growth_campaigns
type TEXT  -- reserve, consume, release, refund, grant
amount INTEGER NOT NULL
balance_after INTEGER
created_at TIMESTAMPTZ
```

#### `growth_pricing`
Country-specific pricing (admin-managed).

```sql
id UUID PK
country_code TEXT NOT NULL
channel TEXT NOT NULL  -- sms, whatsapp_template
provider TEXT
currency TEXT NOT NULL
base_cost_minor INTEGER  -- in minor units
markup_percentage NUMERIC(5,2) DEFAULT 20
credit_cost INTEGER  -- credits per message
effective_date DATE NOT NULL
is_active BOOLEAN DEFAULT true
plan_discounts JSONB  -- {growth: 0.9, business: 0.8}
created_at TIMESTAMPTZ
UNIQUE(country_code, channel, effective_date)
```

### Modified Tables

- `businesses` — add `growth_enabled BOOLEAN DEFAULT false`
- `messaging_opt_outs` — already exists (migration 237), reuse for STOP/UNSUBSCRIBE

## Core Services

### `lib/growth/consent-service.ts`
- `grantConsent(phone, businessId, channel, purpose, source)`
- `revokeConsent(phone, businessId, channel)`
- `verifyConsent(phone, businessId, channel, purpose)`
- `getConsentHistory(phone, businessId)`

### `lib/growth/eligibility-service.ts`
- `getEligibility(phone, businessId)` → { status, reason, channel }
- Checks: consent, opt-out, 24hr window, template approval

### `lib/growth/channel-decision.ts`
- `decideChannel(contact, business)` → whatsapp_template | sms | email | needs_consent
- Automatic — business never chooses manually

### `lib/growth/credit-service.ts`
- `getBalance(businessId)` → { total, reserved, available }
- `reserveCredits(businessId, campaignId, amount)` → success/insufficient
- `consumeCredits(businessId, campaignId, amount)`
- `releaseCredits(businessId, campaignId, amount)`
- `grantCredits(businessId, type, amount, source)`

### `lib/growth/import-service.ts`
- `createImport(businessId, file, mapping)`
- `processImport(importId)` — validate, dedup, create contacts
- `getImportStatus(importId)`

## API Routes

- `POST /api/growth/contacts/import` — upload CSV/Excel
- `GET /api/growth/contacts` — list with pagination
- `POST /api/growth/consent/grant` — grant consent
- `POST /api/growth/consent/revoke` — revoke consent
- `GET /api/growth/eligibility/:phone` — check eligibility
- `POST /api/growth/campaigns` — create campaign
- `POST /api/growth/campaigns/:id/send` — execute campaign
- `GET /api/growth/credits/balance` — credit balance
- `POST /api/growth/credits/topup` — purchase credits
- `GET /api/growth/analytics` — growth analytics

## Dashboard Pages

### Business Dashboard → Growth
1. **Overview** — imported, eligible, invited, converted, revenue, ROI
2. **Contacts** — table with import, search, filter, consent status
3. **Import** — upload flow with field mapping
4. **Consent** — consent status per contact, grant/revoke
5. **Campaigns** — create, schedule, send, track
6. **Analytics** — funnel from import → revenue
7. **Credits** — balance, usage, top-up

### Admin Dashboard → Growth
1. **SMS Pricing** — country/channel pricing management
2. **Growth Analytics** — platform-wide metrics
3. **Consent Rules** — global policies
4. **Feature Flags** — enable/disable per tier

## Feature Flags

```
GROWTH_ENGINE=false
SMS_ACQUISITION=false
CONSENT_ENGINE=false
SMART_CHANNEL_SELECTION=false
ROI_ANALYTICS=false
```

## Plan Entitlements

| Feature | Free | Pro | Premium |
|---------|------|-----|---------|
| Growth Engine | No | Yes | Yes |
| Contact Import | No | Yes | Yes |
| Monthly Credits | 0 | 100 | 500 |
| SMS Acquisition | No | Yes (top-up) | Yes (included) |
| QR Campaigns | Yes | Yes | Yes |
| WhatsApp Links | Yes | Yes | Yes |
| Advanced Analytics | No | No | Yes |
| Segmentation | No | Basic | Advanced |

## Security

- RLS on ALL new tables (business_id = owner's business)
- Consent records are append-only (no UPDATE on status after revoke)
- Credit transactions are append-only
- PII (phone/email) encrypted at rest (Supabase handles this)
- Admin pricing changes logged in audit
- No cross-business visibility

## Rollout

1. Schema + services (silent)
2. Dashboard pages (hidden behind feature flag)
3. Enable for test businesses
4. Enable for Pro/Premium
5. GA after compliance review
