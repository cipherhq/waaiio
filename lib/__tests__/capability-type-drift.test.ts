/**
 * Capability Type DB/TypeScript Drift Detection
 *
 * Proves every canonical capability intended for persistence is representable
 * by the PostgreSQL capability_type enum. Catches drift between
 * shared/capabilities.ts and the migration chain.
 */
import { describe, it, expect } from 'vitest';

describe('capability_type enum coverage', () => {
  it('promo_verification exists as a valid capability_type enum value', () => {
    const fs = require('fs');
    // Collect all enum ADD VALUE statements from migrations
    const migrationDir = 'supabase/migrations';
    const files = fs.readdirSync(migrationDir).sort();
    const enumValues = new Set<string>();

    // Original CREATE TYPE values
    const createSrc = fs.readFileSync(`${migrationDir}/008_capabilities.sql`, 'utf-8');
    const createMatch = createSrc.match(/CREATE TYPE capability_type AS ENUM\s*\(([\s\S]*?)\)/);
    if (createMatch) {
      const values = createMatch[1].match(/'([^']+)'/g);
      if (values) values.forEach((v: string) => enumValues.add(v.replace(/'/g, '')));
    }

    // All ADD VALUE statements
    for (const file of files) {
      const src = fs.readFileSync(`${migrationDir}/${file}`, 'utf-8');
      const addMatches = src.matchAll(/ALTER TYPE capability_type ADD VALUE[^']*'([^']+)'/g);
      for (const m of addMatches) {
        enumValues.add(m[1]);
      }
    }

    // promo_verification must be present
    expect(enumValues.has('promo_verification')).toBe(true);
  });

  it('every persistable canonical capability has a matching enum value', () => {
    const fs = require('fs');

    // Extract canonical capability IDs from shared/capabilities.ts
    const capSrc = fs.readFileSync('shared/capabilities.ts', 'utf-8');
    const capIds: string[] = [];
    const idMatches = capSrc.matchAll(/id:\s*'([^']+)'/g);
    for (const m of idMatches) capIds.push(m[1]);

    // Collect all enum values from migrations
    const migrationDir = 'supabase/migrations';
    const files = fs.readdirSync(migrationDir).sort();
    const enumValues = new Set<string>();

    const createSrc = fs.readFileSync(`${migrationDir}/008_capabilities.sql`, 'utf-8');
    const createMatch = createSrc.match(/CREATE TYPE capability_type AS ENUM\s*\(([\s\S]*?)\)/);
    if (createMatch) {
      const values = createMatch[1].match(/'([^']+)'/g);
      if (values) values.forEach((v: string) => enumValues.add(v.replace(/'/g, '')));
    }
    for (const file of files) {
      const src = fs.readFileSync(`${migrationDir}/${file}`, 'utf-8');
      const addMatches = src.matchAll(/ALTER TYPE capability_type ADD VALUE[^']*'([^']+)'/g);
      for (const m of addMatches) enumValues.add(m[1]);
    }

    // Every canonical capability ID must be in the enum
    const missing = capIds.filter(id => !enumValues.has(id));
    expect(missing).toEqual([]);
  });
});
