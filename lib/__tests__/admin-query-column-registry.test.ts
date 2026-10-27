/**
 * Regression test: admin query route APPROVED_COLUMNS must reference
 * columns that actually exist on the database schema.
 *
 * Root cause of production HTTP 500 on POST /api/admin/query table=businesses:
 * the registry listed 'currency', 'website', 'cover_url', 'booking_advance_days',
 * and 'booking_cancel_hours' which do not exist on public.businesses.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const routeSource = readFileSync(
  resolve('app/api/admin/query/route.ts'), 'utf8',
);

describe('admin query APPROVED_COLUMNS registry', () => {
  // Extract the businesses column list from source
  const match = routeSource.match(/businesses:\s*\[([\s\S]*?)\]/);
  const businessesCols = match
    ? match[1].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) ?? []
    : [];

  it('businesses registry is non-empty', () => {
    expect(businessesCols.length).toBeGreaterThan(10);
  });

  it('businesses registry does not include non-existent column "currency"', () => {
    expect(businessesCols).not.toContain('currency');
  });

  it('businesses registry does not include non-existent column "website"', () => {
    expect(businessesCols).not.toContain('website');
  });

  it('businesses registry uses "cover_photo_url" not "cover_url"', () => {
    expect(businessesCols).not.toContain('cover_url');
    expect(businessesCols).toContain('cover_photo_url');
  });

  it('businesses registry uses "max_advance_booking_days" not "booking_advance_days"', () => {
    expect(businessesCols).not.toContain('booking_advance_days');
    expect(businessesCols).toContain('max_advance_booking_days');
  });

  it('businesses registry uses "cancellation_window_hours" not "booking_cancel_hours"', () => {
    expect(businessesCols).not.toContain('booking_cancel_hours');
    expect(businessesCols).toContain('cancellation_window_hours');
  });

  it('businesses registry includes core required columns', () => {
    for (const col of ['id', 'name', 'slug', 'owner_id', 'status', 'country_code', 'created_at']) {
      expect(businessesCols).toContain(col);
    }
  });
});
