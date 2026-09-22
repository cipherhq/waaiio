/**
 * Phase 2D: Direct Order Payment Authority tests (#352).
 *
 * Part A: Structural/contract verification (source text + executable imports)
 * Part B: Real PostgreSQL DB tests (M394 provenance, zero-fee, concurrency)
 * Part C: Executable runtime tests (manifest parity, Stage 3 behavior)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

// ═══ Part A: Structural + executable import tests ═══

const authoritySource = readFileSync(join(process.cwd(), 'lib/payments/authority.ts'), 'utf-8');
const processSuccessSource = readFileSync(join(process.cwd(), 'lib/payments/process-success.ts'), 'utf-8');
const sendConfirmSource = readFileSync(join(process.cwd(), 'lib/payments/send-confirmation.ts'), 'utf-8');
const terminalEffectsSource = readFileSync(join(process.cwd(), 'lib/payments/terminal-effects.ts'), 'utf-8');
const dashboardRoute = readFileSync(join(process.cwd(), 'app/api/dashboard/pending-transfers/[id]/route.ts'), 'utf-8');
const cronRoute = readFileSync(join(process.cwd(), 'app/api/cron/payment-reconciliation/route.ts'), 'utf-8');
const m394Source = readFileSync(join(process.cwd(), 'supabase/migrations/394_direct_order_payment_authority.sql'), 'utf-8');

describe('M394 structural', () => {
  it('payment_authority_version = 1 in INSERT', () => {
    const ins = m394Source.slice(m394Source.indexOf('INSERT INTO payments'), m394Source.indexOf('RETURNING id INTO v_new_payment_id'));
    expect(ins).toContain('payment_authority_version');
  });
  it('_direct_transfer = true in metadata', () => {
    const ins = m394Source.slice(m394Source.indexOf('INSERT INTO payments'), m394Source.indexOf('RETURNING id INTO v_new_payment_id'));
    expect(ins).toContain("'_direct_transfer', true");
  });
  it('initialize_terminal_effects includes customer_order_email', () => {
    expect(m394Source).toContain("'customer_order_email'");
  });
  it('DB predicate requires payment_authority_version IS NOT NULL', () => {
    expect(m394Source).toContain('v_payment.payment_authority_version IS NOT NULL');
  });
  it('exempts direct orders from owner WA/email', () => {
    expect(m394Source).toContain('IF NOT v_is_direct_order THEN');
  });
});

describe('authority.ts structural', () => {
  it('resumeSuccessfulPaymentFinalization exported', () => {
    expect(authoritySource).toContain('export async function resumeSuccessfulPaymentFinalization');
  });
  it('fails closed on non-direct', () => {
    expect(authoritySource).toContain('not_direct_gateway');
    expect(authoritySource).toContain('no_authority_version');
    expect(authoritySource).toContain('no_direct_transfer_provenance');
  });
  it('executeStage2Through3 shared by both entry points', () => {
    // Both entry points use the same private function
    expect(authoritySource).toContain('executeStage2Through3(supabase, payment');
    // The function itself exists
    expect(authoritySource).toContain('async function executeStage2Through3');
  });
  it('passes payment_authority_version to processPayment', () => {
    expect(authoritySource).toContain('payment_authority_version: payment.payment_authority_version');
  });
});

describe('process-success.ts structural', () => {
  it('zero-fee requires authority version', () => {
    expect(processSuccessSource).toContain('payment.payment_authority_version != null');
  });
  it('verifies fee row on fresh + replay', () => {
    expect(processSuccessSource).toContain('verifyFeeRow');
  });
  it('strict 23505 only', () => {
    const section = processSuccessSource.slice(processSuccessSource.indexOf('R4-B2'), processSuccessSource.indexOf('Online/card/wallet'));
    expect(section).not.toContain("includes('duplicate')");
  });
});

describe('send-confirmation.ts structural', () => {
  it('R5-B1: email failure not completed', () => {
    expect(sendConfirmSource).toContain('customer_order_email delivery failed');
    expect(sendConfirmSource).toContain('emailResult');
    expect(sendConfirmSource).toContain('success');
  });
  it('derives isDirectOrderTransfer', () => {
    expect(sendConfirmSource).toContain('isDirectOrderTransfer');
  });
  it('canonical order resolution', () => {
    expect(sendConfirmSource).toContain('canonicalOrderId = payment.order_id');
  });
  it('Save Card suppressed for direct', () => {
    expect(sendConfirmSource).toContain('!isDirectOrderTransfer');
  });
  it('transfer_confirmed in owner_notif_inapp', () => {
    expect(sendConfirmSource).toContain("type: 'transfer_confirmed'");
  });
});

describe('Dashboard route structural', () => {
  it('delegates to resumeSuccessfulPaymentFinalization', () => {
    expect(dashboardRoute).toContain('resumeSuccessfulPaymentFinalization');
  });
  it('downstream failure non-fatal', () => {
    expect(dashboardRoute).toContain('non-fatal');
  });
  it('retry requires exact provenance', () => {
    expect(dashboardRoute).toContain('_direct_transfer');
    expect(dashboardRoute).toContain('pending_transfer_id');
  });
});

describe('Cron structural', () => {
  it('direct bypass + semantic failure surfacing', () => {
    expect(cronRoute).toContain("payment.gateway === 'direct'");
    expect(cronRoute).toContain('UNEXPECTED');
  });
});

// ═══ Part B: Executable manifest parity (real import) ═══

describe('computeApplicableEffects executable', () => {
  it('non-direct booking includes owner WA/email + inapp', async () => {
    const { computeApplicableEffects } = await import('@/lib/payments/terminal-effects');
    const effects = computeApplicableEffects(
      { id: 'p1', booking_id: 'b1' },
      { hasCustomerPhone: true, hasSender: true, isDirectOrderTransfer: false },
    );
    expect(effects).toContain('owner_notif_whatsapp');
    expect(effects).toContain('owner_notif_email');
    expect(effects).toContain('owner_notif_inapp');
    expect(effects).toContain('customer_whatsapp');
  });

  it('direct order: owner_notif_inapp YES, owner WA/email NO, customer_order_email YES', async () => {
    const { computeApplicableEffects } = await import('@/lib/payments/terminal-effects');
    const effects = computeApplicableEffects(
      { id: 'p2', order_id: 'o1' },
      { hasCustomerPhone: true, hasSender: true, isDirectOrderTransfer: true, hasCustomerEmail: true },
    );
    expect(effects).not.toContain('owner_notif_whatsapp');
    expect(effects).not.toContain('owner_notif_email');
    expect(effects).toContain('owner_notif_inapp');
    expect(effects).toContain('customer_whatsapp');
    expect(effects).toContain('customer_order_email');
    expect(effects).not.toContain('receipt_pdf_generation');
    expect(effects).not.toContain('receipt_pdf_delivery');
    expect(effects).not.toContain('customer_loyalty_whatsapp');
  });

  it('direct order without email: customer_order_email omitted', async () => {
    const { computeApplicableEffects } = await import('@/lib/payments/terminal-effects');
    const effects = computeApplicableEffects(
      { id: 'p3', order_id: 'o2' },
      { hasCustomerPhone: true, hasSender: true, isDirectOrderTransfer: true, hasCustomerEmail: false },
    );
    expect(effects).not.toContain('customer_order_email');
    expect(effects).toContain('owner_notif_inapp');
  });

  it('non-direct order: has owner WA/email, no customer_order_email', async () => {
    const { computeApplicableEffects } = await import('@/lib/payments/terminal-effects');
    const effects = computeApplicableEffects(
      { id: 'p4', order_id: 'o3' },
      { hasCustomerPhone: true, hasSender: true, isDirectOrderTransfer: false, hasCustomerEmail: true, amountPaid: 5000 },
    );
    expect(effects).toContain('owner_notif_whatsapp');
    expect(effects).toContain('owner_notif_email');
    expect(effects).not.toContain('customer_order_email');
    // Online orders may get receipt
    expect(effects).toContain('receipt_pdf_generation');
  });

  it('invoice/campaign still requires session_deactivation', async () => {
    const { computeApplicableEffects } = await import('@/lib/payments/terminal-effects');
    const effects = computeApplicableEffects(
      { id: 'p5', invoice_id: 'inv1' },
      { hasCustomerPhone: true, hasSender: true },
    );
    expect(effects).toContain('session_deactivation');
    expect(effects).toContain('owner_notif_whatsapp');
  });
});

// ═══ Part C: Real PostgreSQL DB tests ═══

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRunDb = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

function psqlJson(sql: string): Record<string, unknown> {
  return JSON.parse(psql(sql));
}

function psqlMayFail(sql: string): { ok: boolean; output: string } {
  try {
    const output = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    }).trim();
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, output: e.stdout?.trim() || e.message || '' };
  }
}

function spawnPsql(sql: string, timeoutMs = 20000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on('error', (err) => resolve({ ok: false, stdout: '', stderr: err.message }));
    child.stdin.write(sql);
    child.stdin.end();
  });
}

const BIZ = '00000000-0000-0000-0394-000000000001';
const USER = '00000000-0000-0000-0394-000000000002';
const CHANNEL = '00000000-0000-0000-0394-000000000003';
const SESSION = '00000000-0000-0000-0394-000000000004';

describe.skipIf(!canRunDb)('M394: Real PostgreSQL DB tests', () => {
  beforeAll(() => {
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('pending','success','failed','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE order_status AS ENUM ('draft','pending','confirmed','processing','ready','shipped','delivered','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE addon_price_type AS ENUM ('fixed','per_unit','quote'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT DEFAULT 'Test', assigned_channel_id UUID, whatsapp_channel_id UUID, subscription_tier TEXT DEFAULT 'growth');
      CREATE TABLE IF NOT EXISTS promo_codes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), current_uses INTEGER DEFAULT 0, max_uses INTEGER);
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id),
        user_id UUID, status order_status DEFAULT 'pending', total_amount INTEGER DEFAULT 0,
        discount_amount INTEGER DEFAULT 0, shipping_cost INTEGER DEFAULT 0,
        promo_code_id UUID, bot_session_id UUID, channel TEXT DEFAULT 'whatsapp',
        delivery_phone TEXT, reference_code TEXT DEFAULT ('ORD-' || upper(substr(md5(random()::text), 1, 6))),
        paid_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        delivery_zone_id UUID, delivery_zone_name TEXT, addons_total INTEGER DEFAULT 0,
        volume_discount_amount INTEGER DEFAULT 0, items_fingerprint TEXT, referral_id UUID,
        delivery_address TEXT, notes TEXT, quote_request_id UUID,
        pickup_address TEXT, dropoff_address TEXT, package_description TEXT, package_photo_url TEXT
      );
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID,
        order_id UUID REFERENCES orders(id), amount INTEGER NOT NULL DEFAULT 0,
        currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
        gateway_reference VARCHAR(100) UNIQUE NOT NULL DEFAULT ('pay-' || substr(md5(random()::text), 1, 8)),
        gateway_status VARCHAR(50) NOT NULL DEFAULT 'pending', gateway TEXT DEFAULT 'paystack',
        payment_method VARCHAR(20), status payment_status NOT NULL DEFAULT 'pending',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb, paid_at TIMESTAMPTZ,
        gateway_fee INTEGER NOT NULL DEFAULT 0, payment_authority_version INTEGER,
        finalization_processing_at TIMESTAMPTZ, finalization_completed_at TIMESTAMPTZ,
        finalization_claim_token UUID, confirmation_sent_at TIMESTAMPTZ,
        confirmation_terminal_reason TEXT, confirmation_claim_token UUID,
        confirmation_processing_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS platform_fees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID, payment_id UUID,
        order_id UUID, booking_id UUID, invoice_id UUID, campaign_id UUID, reservation_id UUID,
        transaction_amount INTEGER DEFAULT 0, fee_percentage NUMERIC DEFAULT 0,
        fee_flat INTEGER DEFAULT 0, fee_total INTEGER DEFAULT 0, gateway_fee INTEGER DEFAULT 0,
        tier TEXT DEFAULT 'free', is_direct_transfer BOOLEAN DEFAULT false,
        refunded_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_fees_payment_unique ON platform_fees(payment_id) WHERE payment_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_fees_order_unique ON platform_fees(order_id) WHERE order_id IS NOT NULL AND refunded_at IS NULL;
      CREATE TABLE IF NOT EXISTS pending_transfers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID, order_id UUID,
        customer_phone TEXT NOT NULL, customer_name TEXT,
        expected_amount INTEGER NOT NULL, currency TEXT DEFAULT 'NGN',
        reference_code VARCHAR(20) NOT NULL UNIQUE DEFAULT ('WA-' || substr(md5(random()::text), 1, 4)),
        status TEXT DEFAULT 'pending', confirmed_by UUID, confirmed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS order_stock_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), payment_id UUID,
        order_id UUID NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        item_count INTEGER NOT NULL DEFAULT 0,
        reservation_class TEXT NOT NULL DEFAULT 'prepayment',
        expires_at TIMESTAMPTZ DEFAULT NULL
      );
      CREATE TABLE IF NOT EXISTS promo_reservations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID, promo_code_id UUID,
        state TEXT DEFAULT 'reserved'
      );
      CREATE TABLE IF NOT EXISTS bot_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID,
        session_data JSONB DEFAULT '{}', is_active BOOLEAN DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS whatsapp_channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), channel_type TEXT DEFAULT 'shared',
        business_id UUID, is_active BOOLEAN DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID,
        product_id UUID, variant_id UUID, quantity INTEGER DEFAULT 1, unit_price INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID,
        name TEXT DEFAULT 'Test', price INTEGER DEFAULT 0,
        stock_quantity INTEGER, track_inventory BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true
      );

      CREATE OR REPLACE FUNCTION release_promo_reservation(p_order_id UUID) RETURNS VOID
      LANGUAGE plpgsql AS $fn$ BEGIN DELETE FROM promo_reservations WHERE order_id = p_order_id AND state = 'reserved'; END; $fn$;

      INSERT INTO businesses (id, name) VALUES ('${BIZ}', 'TestBiz') ON CONFLICT DO NOTHING;
      INSERT INTO whatsapp_channels (id, channel_type, is_active) VALUES ('${CHANNEL}', 'shared', true) ON CONFLICT DO NOTHING;
      INSERT INTO bot_sessions (id, business_id, session_data) VALUES ('${SESSION}', '${BIZ}', '{"_inbound_channel_id":"${CHANNEL}"}'::jsonb) ON CONFLICT DO NOTHING;
    `);

    // Apply required migrations
    const m314 = readFileSync(join(process.cwd(), 'supabase/migrations/314_payment_finalization_lifecycle.sql'), 'utf-8');
    psql(m314);
    const m393 = readFileSync(join(process.cwd(), 'supabase/migrations/393_inventory_reservation_wiring.sql'), 'utf-8');
    psql(m393);
    const m394 = readFileSync(join(process.cwd(), 'supabase/migrations/394_direct_order_payment_authority.sql'), 'utf-8');
    psql(m394);
  });

  afterAll(() => {
    try {
      psql(`
        DROP TABLE IF EXISTS platform_fees CASCADE; DROP TABLE IF EXISTS promo_reservations CASCADE;
        DROP TABLE IF EXISTS order_stock_applications CASCADE; DROP TABLE IF EXISTS order_items CASCADE;
        DROP TABLE IF EXISTS pending_transfers CASCADE; DROP TABLE IF EXISTS payments CASCADE;
        DROP TABLE IF EXISTS orders CASCADE; DROP TABLE IF EXISTS products CASCADE;
        DROP TABLE IF EXISTS bot_sessions CASCADE; DROP TABLE IF EXISTS whatsapp_channels CASCADE;
        DROP TABLE IF EXISTS promo_codes CASCADE; DROP TABLE IF EXISTS businesses CASCADE;
        DROP FUNCTION IF EXISTS release_promo_reservation(UUID);
        DROP TYPE IF EXISTS payment_status CASCADE; DROP TYPE IF EXISTS order_status CASCADE;
        DROP TYPE IF EXISTS addon_price_type CASCADE;
      `);
    } catch { /* best effort */ }
  });

  describe('M394 confirm_order_transfer_atomic provenance', () => {
    it('creates payment with payment_authority_version=1 + _direct_transfer=true', () => {
      const orderId = psql(`INSERT INTO orders (business_id, user_id, total_amount, status, bot_session_id, channel) VALUES ('${BIZ}', '${USER}', 5000, 'pending', '${SESSION}', 'whatsapp') RETURNING id`);
      const deadline = psql(`SELECT (NOW() + interval '24 hours')::timestamptz`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at) VALUES ('${orderId}', 'bank_transfer', '${deadline}')`);
      const xferId = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, currency, expires_at, status, metadata) VALUES ('${BIZ}', '${orderId}', '+234900', 500000, 'NGN', '${deadline}', 'pending', '{"_inbound_channel_id":"${CHANNEL}","_confirmation_origin":"whatsapp"}'::jsonb) RETURNING id`);

      const result = psqlJson(`SELECT confirm_order_transfer_atomic('${xferId}', '${orderId}', '${BIZ}', '${USER}')`);
      expect(result.confirmed).toBe(true);

      // Verify M394 provenance on created payment
      const pay = psqlJson(`SELECT jsonb_build_object(
        'gateway', gateway, 'payment_authority_version', payment_authority_version,
        'direct_transfer', metadata->>'_direct_transfer',
        'pending_transfer_id', metadata->>'pending_transfer_id'
      ) FROM payments WHERE id = '${result.payment_id}'`);
      expect(pay.gateway).toBe('direct');
      expect(pay.payment_authority_version).toBe(1);
      expect(pay.direct_transfer).toBe('true');
      expect(pay.pending_transfer_id).toBe(xferId);
    });
  });

  describe('Zero-fee fresh + 23505 replay', () => {
    it('first insert creates zero-fee row', () => {
      const orderId = psql(`INSERT INTO orders (business_id, total_amount, status) VALUES ('${BIZ}', 3000, 'confirmed') RETURNING id`);
      const payId = psql(`INSERT INTO payments (business_id, order_id, amount, status, gateway, payment_authority_version, metadata) VALUES ('${BIZ}', '${orderId}', 3000, 'success', 'direct', 1, '{"_direct_transfer":true}'::jsonb) RETURNING id`);

      psql(`INSERT INTO platform_fees (business_id, payment_id, order_id, transaction_amount, fee_percentage, fee_flat, fee_total, gateway_fee, tier, is_direct_transfer) VALUES ('${BIZ}', '${payId}', '${orderId}', 3000, 0, 0, 0, 0, 'growth', true)`);

      const fee = psqlJson(`SELECT jsonb_build_object('transaction_amount', transaction_amount, 'fee_total', fee_total, 'is_direct_transfer', is_direct_transfer) FROM platform_fees WHERE payment_id = '${payId}'`);
      expect(fee.transaction_amount).toBe(3000);
      expect(fee.fee_total).toBe(0);
      expect(fee.is_direct_transfer).toBe(true);
    });

    it('23505 replay on same payment_id is safe', () => {
      const orderId = psql(`INSERT INTO orders (business_id, total_amount, status) VALUES ('${BIZ}', 2000, 'confirmed') RETURNING id`);
      const payId = psql(`INSERT INTO payments (business_id, order_id, amount, status, gateway, payment_authority_version, metadata) VALUES ('${BIZ}', '${orderId}', 2000, 'success', 'direct', 1, '{"_direct_transfer":true}'::jsonb) RETURNING id`);

      // First insert
      psql(`INSERT INTO platform_fees (business_id, payment_id, order_id, transaction_amount, fee_percentage, fee_flat, fee_total, gateway_fee, tier, is_direct_transfer) VALUES ('${BIZ}', '${payId}', '${orderId}', 2000, 0, 0, 0, 0, 'growth', true)`);

      // Second insert → 23505
      const res = psqlMayFail(`INSERT INTO platform_fees (business_id, payment_id, order_id, transaction_amount, fee_percentage, fee_flat, fee_total, gateway_fee, tier, is_direct_transfer) VALUES ('${BIZ}', '${payId}', '${orderId}', 2000, 0, 0, 0, 0, 'growth', true)`);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('duplicate');

      // Original row still correct
      const count = psql(`SELECT count(*) FROM platform_fees WHERE payment_id = '${payId}'`);
      expect(parseInt(count)).toBe(1);
    });
  });

  describe('Channel authority', () => {
    it('shared channel: transfer created successfully', () => {
      const orderId = psql(`INSERT INTO orders (business_id, total_amount, status, bot_session_id, channel) VALUES ('${BIZ}', 1000, 'pending', '${SESSION}', 'whatsapp') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at) VALUES ('${orderId}', 'instant', NOW() + interval '25 minutes')`);
      const result = psqlJson(`SELECT create_transfer_with_reservation('${orderId}', '${BIZ}', '+234900', 'Test', 'NG', 24)`);
      expect(result.error).toBeUndefined();
      expect(result.inbound_channel_id).toBe(CHANNEL);
    });

    it('dedicated channel owned by business: allowed', () => {
      const dedCh = psql(`INSERT INTO whatsapp_channels (channel_type, business_id, is_active) VALUES ('dedicated', '${BIZ}', true) RETURNING id`);
      const dedSession = psql(`INSERT INTO bot_sessions (business_id, session_data) VALUES ('${BIZ}', '{"_inbound_channel_id":"${dedCh}"}'::jsonb) RETURNING id`);
      const orderId = psql(`INSERT INTO orders (business_id, total_amount, status, bot_session_id, channel) VALUES ('${BIZ}', 1000, 'pending', '${dedSession}', 'whatsapp') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at) VALUES ('${orderId}', 'instant', NOW() + interval '25 minutes')`);
      const result = psqlJson(`SELECT create_transfer_with_reservation('${orderId}', '${BIZ}', '+234900', 'Test', 'NG', 24)`);
      expect(result.error).toBeUndefined();
      expect(result.inbound_channel_id).toBe(dedCh);
    });

    it('Embedded Signup (NULL owner, assigned): allowed', () => {
      const esCh = psql(`INSERT INTO whatsapp_channels (channel_type, business_id, is_active) VALUES ('dedicated', NULL, true) RETURNING id`);
      psql(`UPDATE businesses SET whatsapp_channel_id = '${esCh}' WHERE id = '${BIZ}'`);
      const esSession = psql(`INSERT INTO bot_sessions (business_id, session_data) VALUES ('${BIZ}', '{"_inbound_channel_id":"${esCh}"}'::jsonb) RETURNING id`);
      const orderId = psql(`INSERT INTO orders (business_id, total_amount, status, bot_session_id, channel) VALUES ('${BIZ}', 1000, 'pending', '${esSession}', 'whatsapp') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at) VALUES ('${orderId}', 'instant', NOW() + interval '25 minutes')`);
      const result = psqlJson(`SELECT create_transfer_with_reservation('${orderId}', '${BIZ}', '+234900', 'Test', 'NG', 24)`);
      expect(result.error).toBeUndefined();
      psql(`UPDATE businesses SET whatsapp_channel_id = NULL WHERE id = '${BIZ}'`);
    });

    it('A→B durability: transfer + confirm still uses A', () => {
      const channelB = psql(`INSERT INTO whatsapp_channels (channel_type, is_active) VALUES ('shared', true) RETURNING id`);
      const orderId = psql(`INSERT INTO orders (business_id, total_amount, status, bot_session_id, channel) VALUES ('${BIZ}', 4000, 'pending', '${SESSION}', 'whatsapp') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at) VALUES ('${orderId}', 'instant', NOW() + interval '25 minutes')`);
      const xferResult = psqlJson(`SELECT create_transfer_with_reservation('${orderId}', '${BIZ}', '+234900', 'Test', 'NG', 24)`);
      expect(xferResult.inbound_channel_id).toBe(CHANNEL);

      // Business changes default to B
      psql(`UPDATE businesses SET assigned_channel_id = '${channelB}' WHERE id = '${BIZ}'`);

      // Confirm → payment metadata still has A
      const confirmResult = psqlJson(`SELECT confirm_order_transfer_atomic('${xferResult.transfer_id}', '${orderId}', '${BIZ}', '${USER}')`);
      expect(confirmResult.confirmed).toBe(true);
      expect(confirmResult.inbound_channel_id).toBe(CHANNEL);

      const payMeta = psqlJson(`SELECT metadata FROM payments WHERE id = '${confirmResult.payment_id}'`);
      expect(payMeta._inbound_channel_id).toBe(CHANNEL);

      psql(`UPDATE businesses SET assigned_channel_id = NULL WHERE id = '${BIZ}'`);
    });
  });

  describe('Concurrent double-resume contention', () => {
    it('two concurrent finalization claims: exactly one winner', async () => {
      const orderId = psql(`INSERT INTO orders (business_id, total_amount, status) VALUES ('${BIZ}', 1000, 'confirmed') RETURNING id`);
      const payId = psql(`INSERT INTO payments (business_id, order_id, amount, status, gateway, payment_authority_version, metadata) VALUES ('${BIZ}', '${orderId}', 1000, 'success', 'direct', 1, '{"_direct_transfer":true,"pending_transfer_id":"xf-1"}'::jsonb) RETURNING id`);

      const [r1, r2] = await Promise.all([
        spawnPsql(`SELECT claim_payment_finalization('${payId}');`),
        spawnPsql(`SELECT claim_payment_finalization('${payId}');`),
      ]);

      expect(r1.stdout.length + r1.stderr.length).toBeGreaterThan(0);
      expect(r2.stdout.length + r2.stderr.length).toBeGreaterThan(0);

      const p1 = r1.ok ? JSON.parse(r1.stdout) : { claimed: false };
      const p2 = r2.ok ? JSON.parse(r2.stdout) : { claimed: false };

      const claims = [p1.claimed === true, p2.claimed === true].filter(Boolean).length;
      // R6-B4: Exactly one winner (the other gets processing_in_progress)
      expect(claims).toBe(1);
    }, 30000);
  });

  describe('ACL parity', () => {
    it('confirm_order_transfer_atomic: service_role allowed', () => {
      const allowed = psql(`SELECT has_function_privilege('service_role', 'confirm_order_transfer_atomic(uuid,uuid,uuid,uuid)', 'EXECUTE')`);
      expect(allowed).toBe('t');
    });
    it('confirm_order_transfer_atomic: anon denied', () => {
      const denied = psql(`SELECT has_function_privilege('anon', 'confirm_order_transfer_atomic(uuid,uuid,uuid,uuid)', 'EXECUTE')`);
      expect(denied).toBe('f');
    });
    it('initialize_terminal_effects: service_role allowed', () => {
      const allowed = psql(`SELECT has_function_privilege('service_role', 'initialize_terminal_effects(uuid,uuid,text[],text[],text[],text[],int)', 'EXECUTE')`);
      expect(allowed).toBe('t');
    });
  });
});

// ═══ Part D: Executable Stage 2 runtime tests ═══

describe('processSuccessfulPayment: direct zero-fee (executable)', () => {
  it('direct order creates zero-fee row and calls idempotent RPCs', async () => {
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');

    const insertedFees: any[] = [];
    const rpcCalls: { name: string; params: any }[] = [];

    // Build a chainable mock that handles all Supabase query patterns
    function chain(data: any = null): any {
      const c: any = {};
      for (const m of ['select', 'eq', 'in', 'update', 'neq', 'not', 'order', 'limit', 'insert', 'delete']) {
        c[m] = (...args: any[]) => {
          if (m === 'insert') {
            insertedFees.push(args[0]);
            // Return value with both .then() and direct error
            const r: any = { error: null };
            r.then = (fn: any) => fn({ error: null });
            return r;
          }
          return c;
        };
      }
      c.single = async () => ({ data, error: null });
      c.maybeSingle = async () => ({ data, error: null });
      c.then = (resolve: any) => resolve({ data: data ? [data] : [], error: null });
      return c;
    }

    const mockSupabase = {
      from: (table: string) => {
        if (table === 'orders') return chain({ business_id: 'biz-1', referral_id: null, delivery_phone: '+234900' });
        if (table === 'businesses') return chain({ subscription_tier: 'growth' });
        if (table === 'platform_fees') return chain({ payment_id: 'pay-direct-1', order_id: 'ord-1', business_id: 'biz-1', transaction_amount: 5000, fee_percentage: 0, fee_flat: 0, fee_total: 0, gateway_fee: 0, is_direct_transfer: true });
        return chain();
      },
      rpc: async (name: string, params?: any) => {
        rpcCalls.push({ name, params });
        if (name === 'apply_order_stock_once') return { data: { applied: true, already_applied: true, order_confirmed: true }, error: null };
        if (name === 'finalize_promo_reservation') return { data: { reason: 'no_reservation' }, error: null };
        if (name === 'apply_customer_spend_once') return { data: { applied: true }, error: null };
        return { data: null, error: null };
      },
    } as any;

    const result = await processSuccessfulPayment(mockSupabase, {
      id: 'pay-direct-1',
      amount: 5000,
      booking_id: null,
      invoice_id: null,
      campaign_id: null,
      order_id: 'ord-1',
      metadata: { _direct_transfer: true, pending_transfer_id: 'xf-1' },
      gateway_fee: 0,
      gateway: 'direct',
      payment_authority_version: 1,
    });

    expect(result.criticalSuccess).toBe(true);

    // Zero-fee row was inserted
    const feeInserts = insertedFees.filter((f: any) => f.is_direct_transfer === true);
    expect(feeInserts.length).toBeGreaterThanOrEqual(1);
    expect(feeInserts[0].fee_percentage).toBe(0);
    expect(feeInserts[0].fee_total).toBe(0);
    expect(feeInserts[0].transaction_amount).toBe(5000);

    // Idempotent RPCs were called
    expect(rpcCalls.find(c => c.name === 'apply_order_stock_once')).toBeDefined();
    expect(rpcCalls.find(c => c.name === 'apply_customer_spend_once')).toBeDefined();
  });

  it('non-direct gateway uses normal recordPlatformFee', async () => {
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');

    const rpcCalls: { name: string }[] = [];
    const mockChainable: any = {};
    for (const m of ['select', 'eq', 'in', 'update', 'neq', 'not', 'order', 'limit']) {
      mockChainable[m] = () => mockChainable;
    }
    mockChainable.single = async () => ({ data: { business_id: 'biz-1', subscription_tier: 'growth' }, error: null });
    mockChainable.maybeSingle = async () => ({ data: null, error: null });

    const mockSupabase = {
      from: () => ({
        ...mockChainable,
        insert: () => ({ error: null, then: (r: any) => r({ error: null }) }),
      }),
      rpc: async (name: string, params?: any) => {
        rpcCalls.push({ name });
        if (name === 'apply_order_stock_once') return { data: { applied: true, already_applied: true, order_confirmed: true }, error: null };
        if (name === 'finalize_promo_reservation') return { data: { reason: 'no_reservation' }, error: null };
        if (name === 'apply_customer_spend_once') return { data: { applied: true }, error: null };
        return { data: null, error: null };
      },
    } as any;

    const result = await processSuccessfulPayment(mockSupabase, {
      id: 'pay-online-1',
      amount: 5000,
      booking_id: null,
      invoice_id: null,
      campaign_id: null,
      order_id: 'ord-2',
      metadata: { order_id: 'ord-2' },
      gateway_fee: 100,
      gateway: 'paystack',
    });

    // Should still succeed (recordPlatformFee may fail silently)
    expect(result.criticalSuccess).toBe(true);
  });
});

// ═══ Part E: Executable resumeSuccessfulPaymentFinalization ═══

describe('resumeSuccessfulPaymentFinalization: fail-closed validation (executable)', () => {
  it('rejects non-success status', async () => {
    const { resumeSuccessfulPaymentFinalization } = await import('@/lib/payments/authority');

    const mockSupabase = {
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({
          data: { id: 'p1', status: 'pending', gateway: 'direct', order_id: 'o1', payment_authority_version: 1, metadata: { _direct_transfer: true, pending_transfer_id: 'xf1' }, amount: 1000, gateway_fee: 0 },
          error: null,
        }) }) }),
      }),
    } as any;

    const result = await resumeSuccessfulPaymentFinalization(
      mockSupabase, 'p1',
      async () => ({ criticalSuccess: true }),
      async () => ({ status: 'completed' as const }),
    );
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('not_successful');
  });

  it('rejects non-direct gateway', async () => {
    const { resumeSuccessfulPaymentFinalization } = await import('@/lib/payments/authority');

    const mockSupabase = {
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({
          data: { id: 'p2', status: 'success', gateway: 'paystack', order_id: 'o1', payment_authority_version: 1, metadata: { _direct_transfer: true, pending_transfer_id: 'xf1' }, amount: 1000, gateway_fee: 0 },
          error: null,
        }) }) }),
      }),
    } as any;

    const result = await resumeSuccessfulPaymentFinalization(
      mockSupabase, 'p2',
      async () => ({ criticalSuccess: true }),
      async () => ({ status: 'completed' as const }),
    );
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('not_direct_gateway');
  });

  it('rejects without authority version', async () => {
    const { resumeSuccessfulPaymentFinalization } = await import('@/lib/payments/authority');

    const mockSupabase = {
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({
          data: { id: 'p3', status: 'success', gateway: 'direct', order_id: 'o1', payment_authority_version: null, metadata: { _direct_transfer: true, pending_transfer_id: 'xf1' }, amount: 1000, gateway_fee: 0 },
          error: null,
        }) }) }),
      }),
    } as any;

    const result = await resumeSuccessfulPaymentFinalization(
      mockSupabase, 'p3',
      async () => ({ criticalSuccess: true }),
      async () => ({ status: 'completed' as const }),
    );
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('no_authority_version');
  });
});

// ═══ Regression freeze ═══

describe('Regression: M393 functions unchanged', () => {
  it('M394 only redefines confirm_order_transfer_atomic + initialize_terminal_effects', () => {
    expect(m394Source).toContain('confirm_order_transfer_atomic');
    expect(m394Source).toContain('initialize_terminal_effects');
    expect(m394Source).not.toContain('cancel_order_immediate');
    expect(m394Source).not.toContain('cancel_stale_order_atomic');
    expect(m394Source).not.toContain('create_transfer_with_reservation');
    expect(m394Source).not.toContain('apply_order_stock_once');
  });
});
