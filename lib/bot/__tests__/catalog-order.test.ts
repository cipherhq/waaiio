import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Contract tests for the create_catalog_order_atomic RPC function.
 * Verifies the migration SQL contains the expected security and atomicity patterns.
 */

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/231_atomic_catalog_order.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf-8');

describe('Catalog order atomicity (migration 231)', () => {
  it('create_catalog_order_atomic function exists', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION create_catalog_order_atomic');
  });

  it('uses FOR UPDATE row locking on products', () => {
    // Prevents race conditions where two concurrent orders both see
    // sufficient stock and decrement past zero
    expect(migration).toContain('FOR UPDATE');
  });

  it('runs as SECURITY DEFINER (bypasses RLS)', () => {
    expect(migration).toContain('SECURITY DEFINER');
  });

  it('sets search_path to public (prevents search_path hijacking)', () => {
    expect(migration).toContain('SET search_path = public');
  });

  it('uses DB-authoritative price, not webhook price', () => {
    // The function uses v_product.price from the DB, never trusts
    // a price sent by the client/webhook
    expect(migration).toContain('v_product.price');
    // The JSONB items input only contains product_id and quantity, no price
    expect(migration).toContain("p_items JSONB -- array of {product_id, quantity}");
  });

  it('checks inventory before decrementing', () => {
    // stock_quantity must be >= requested quantity
    expect(migration).toContain('stock_quantity <');
    // Out-of-stock items are tracked and returned
    expect(migration).toContain('v_out_of_stock');
  });

  it('decrements inventory atomically', () => {
    expect(migration).toContain('stock_quantity = stock_quantity -');
  });

  it('validates product belongs to the business', () => {
    expect(migration).toContain('v_product.business_id != p_business_id');
  });

  it('validates product is active', () => {
    expect(migration).toContain('v_product.is_active');
  });

  it('includes dedup check via processed_webhook_events', () => {
    expect(migration).toContain('processed_webhook_events');
    expect(migration).toContain("'meta-order-' || p_meta_message_id");
  });

  it('returns structured result with success flag', () => {
    expect(migration).toContain("'success', true");
    expect(migration).toContain("'success', false");
    expect(migration).toContain("'order_id'");
    expect(migration).toContain("'total_amount'");
  });

  it('returns no_valid_items when all items fail validation', () => {
    expect(migration).toContain("'no_valid_items'");
    expect(migration).toContain('v_valid_count = 0');
  });

  it('returns duplicate reason on repeated meta message ID', () => {
    expect(migration).toContain("'reason', 'duplicate'");
  });

  it('free orders are auto-confirmed (zero total)', () => {
    // When total is 0, order status is confirmed (no payment needed)
    expect(migration).toContain("WHEN v_total_amount > 0 THEN 'pending'");
    expect(migration).toContain("ELSE 'confirmed'");
  });
});
