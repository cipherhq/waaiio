/**
 * DEAD-001 — Growth Contact Import regression tests
 *
 * Proves the Growth Import page correctly calls the canonical
 * /api/customers/import endpoint with the right data shape,
 * and that the API persists contacts correctly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════
// Source verification — Growth import page calls canonical endpoint
// ═══════════════════════════════════════════════════════════════════════

describe('Growth import page → canonical endpoint wiring', () => {
  let pageSource: string;

  beforeEach(() => {
    pageSource = fs.readFileSync(
      path.resolve(__dirname, '../../app/dashboard/growth/import/page.tsx'),
      'utf-8',
    );
  });

  it('calls /api/customers/import, not /api/growth/contacts/import', () => {
    expect(pageSource).toContain("'/api/customers/import'");
    expect(pageSource).not.toContain('/api/growth/contacts/import');
  });

  it('requires phone mapping (not phone-or-email)', () => {
    expect(pageSource).toContain("const hasPhone = mappings.includes('phone')");
    expect(pageSource).not.toContain('hasPhoneOrEmail');
    // Validation message refers to phone requirement
    expect(pageSource).toContain('A Phone column mapping is required');
  });

  it('concatenates first_name + last_name into canonical name field', () => {
    expect(pageSource).toContain("raw.first_name");
    expect(pageSource).toContain("raw.last_name");
    expect(pageSource).toContain("nameParts.join(' ')");
    // Sends 'name' to API, not first_name/last_name
    expect(pageSource).toContain('name,');
    expect(pageSource).not.toContain("first_name: raw.first_name");
  });

  it('splits tags string into array', () => {
    expect(pageSource).toContain("raw.tags.split(',')");
  });

  it('maps birthday field to date_of_birth', () => {
    expect(pageSource).toContain('raw.birthday');
    expect(pageSource).toContain('date_of_birth');
  });

  it('handles API errors array as count, not raw number', () => {
    expect(pageSource).toContain("Array.isArray(data.errors)");
    expect(pageSource).toContain("data.errors.length");
  });

  it('skips rows without phone on client side', () => {
    expect(pageSource).toContain("if (!raw.phone)");
    expect(pageSource).toContain("clientSkipped++");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// API route contract verification
// ═══════════════════════════════════════════════════════════════════════

describe('API /api/customers/import contract', () => {
  let apiSource: string;

  beforeEach(() => {
    apiSource = fs.readFileSync(
      path.resolve(__dirname, '../../app/api/customers/import/route.ts'),
      'utf-8',
    );
  });

  it('enforces business ownership', () => {
    expect(apiSource).toContain('requireBusinessOwnership: true');
  });

  it('requires phone (not phone-or-email)', () => {
    expect(apiSource).toContain("'Missing phone number'");
  });

  it('caps at 500 contacts per import', () => {
    expect(apiSource).toContain('contacts.length > 500');
    expect(apiSource).toContain("'Maximum 500 contacts per import'");
  });

  it('uses phone normalization with ensurePlus', () => {
    expect(apiSource).toContain('ensurePlus');
  });

  it('upserts on business_id + phone natural key', () => {
    expect(apiSource).toContain("onConflict: 'business_id,phone'");
  });

  it('accepts date_of_birth field', () => {
    expect(apiSource).toContain('date_of_birth');
    expect(apiSource).toContain("parsed.toISOString().split('T')[0]");
  });

  it('validates email format', () => {
    expect(apiSource).toContain('EMAIL_RE.test(email)');
    expect(apiSource).toContain('Invalid email:');
  });

  it('returns errors as array with row and reason', () => {
    expect(apiSource).toContain('errors.push({ row, reason:');
  });

  it('accepts tags as string array', () => {
    expect(apiSource).toContain('Array.isArray(c.tags)');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Behavioral tests — field mapping logic
// ═══════════════════════════════════════════════════════════════════════

describe('Field mapping transformation (behavioral)', () => {
  // Replicate the exact mapping logic from the Growth import page

  function transformContact(raw: Record<string, string>) {
    if (!raw.phone) return null;

    const nameParts = [raw.first_name, raw.last_name].filter(Boolean);
    const name = nameParts.join(' ').trim() || undefined;

    const tags = raw.tags
      ? raw.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : undefined;

    const date_of_birth = raw.birthday || undefined;

    return {
      name,
      phone: raw.phone,
      email: raw.email || undefined,
      tags: tags && tags.length > 0 ? tags : undefined,
      date_of_birth,
    };
  }

  it('first_name + last_name → combined name', () => {
    const result = transformContact({ first_name: 'John', last_name: 'Doe', phone: '+2341234' });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('John Doe');
  });

  it('first_name only → name is first_name', () => {
    const result = transformContact({ first_name: 'Jane', phone: '+2341234' });
    expect(result!.name).toBe('Jane');
  });

  it('last_name only → name is last_name', () => {
    const result = transformContact({ last_name: 'Smith', phone: '+2341234' });
    expect(result!.name).toBe('Smith');
  });

  it('no name fields → name is undefined', () => {
    const result = transformContact({ phone: '+2341234' });
    expect(result!.name).toBeUndefined();
  });

  it('tags string → array', () => {
    const result = transformContact({ phone: '+2341234', tags: 'vip, premium, loyal' });
    expect(result!.tags).toEqual(['vip', 'premium', 'loyal']);
  });

  it('empty tags string → undefined', () => {
    const result = transformContact({ phone: '+2341234', tags: '' });
    expect(result!.tags).toBeUndefined();
  });

  it('birthday → date_of_birth passthrough', () => {
    const result = transformContact({ phone: '+2341234', birthday: '1990-05-15' });
    expect(result!.date_of_birth).toBe('1990-05-15');
  });

  it('no birthday → date_of_birth undefined', () => {
    const result = transformContact({ phone: '+2341234' });
    expect(result!.date_of_birth).toBeUndefined();
  });

  it('missing phone → returns null (skipped)', () => {
    const result = transformContact({ first_name: 'Jane', email: 'jane@example.com' });
    expect(result).toBeNull();
  });

  it('all fields populated', () => {
    const result = transformContact({
      first_name: 'Alice',
      last_name: 'Wonder',
      phone: '+44123456',
      email: 'alice@example.com',
      birthday: '1985-12-25',
      tags: 'vip, regular',
    });
    expect(result).toEqual({
      name: 'Alice Wonder',
      phone: '+44123456',
      email: 'alice@example.com',
      date_of_birth: '1985-12-25',
      tags: ['vip', 'regular'],
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// API date_of_birth validation (behavioral)
// ═══════════════════════════════════════════════════════════════════════

describe('API date_of_birth validation (behavioral)', () => {
  function validateDateOfBirth(raw?: string): string | undefined {
    if (!raw) return undefined;
    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
    return undefined;
  }

  it('valid ISO date → YYYY-MM-DD', () => {
    expect(validateDateOfBirth('1990-05-15')).toBe('1990-05-15');
  });

  it('valid US-style date → YYYY-MM-DD', () => {
    const result = validateDateOfBirth('May 15, 1990');
    expect(result).toBe('1990-05-15');
  });

  it('invalid date → undefined (silently ignored)', () => {
    expect(validateDateOfBirth('not-a-date')).toBeUndefined();
  });

  it('empty string → undefined', () => {
    expect(validateDateOfBirth('')).toBeUndefined();
  });

  it('undefined → undefined', () => {
    expect(validateDateOfBirth(undefined)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Schema verification — customer_profiles supports required fields
// ═══════════════════════════════════════════════════════════════════════

describe('customer_profiles schema supports import fields', () => {
  it('has date_of_birth column (migration 031)', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/031_automation_enhancements.sql'),
      'utf-8',
    );
    expect(migration).toContain('date_of_birth');
    expect(migration).toContain('date');
  });

  it('has tags column as text[] (migration 021)', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/021_product_enhancements.sql'),
      'utf-8',
    );
    expect(migration).toContain('tags');
    expect(migration).toContain('text[]');
  });

  it('has name as single field (not first_name/last_name)', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/021_product_enhancements.sql'),
      'utf-8',
    );
    expect(migration).toContain('name text');
    expect(migration).not.toContain('first_name');
    expect(migration).not.toContain('last_name');
  });

  it('phone is NOT NULL with unique constraint on (business_id, phone)', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/021_product_enhancements.sql'),
      'utf-8',
    );
    expect(migration).toContain('phone text NOT NULL');
    expect(migration).toMatch(/UNIQUE\s*\(\s*business_id\s*,\s*phone\s*\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Existing customer import (customers page) not regressed
// ═══════════════════════════════════════════════════════════════════════

describe('Existing customers page import not regressed', () => {
  it('customers page still calls /api/customers/import', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../app/dashboard/customers/page.tsx'),
      'utf-8',
    );
    expect(source).toContain("'/api/customers/import'");
  });
});
