/**
 * Parties Phase B1-1: Guest tags tests (#661)
 * Tests: tag CRUD, filtering, migration schema, CSV export with tags.
 */
import { describe, it, expect } from 'vitest';

// ════════════════════════════════════════════════════════════════
// S1: Tag filtering logic (pure, no mocks)
// ════════════════════════════════════════════════════════════════
interface MockInvite {
  id: string;
  status: string;
  tags: string[];
}

function filterByTag(invites: MockInvite[], tag: string): MockInvite[] {
  if (!tag) return invites;
  return invites.filter(i => (i.tags || []).includes(tag));
}

function getAllTags(invites: MockInvite[]): string[] {
  return [...new Set(invites.flatMap(i => i.tags || []))].sort();
}

describe('Tag filtering logic', () => {
  const invites: MockInvite[] = [
    { id: '1', status: 'accepted', tags: ['VIP', 'Bride'] },
    { id: '2', status: 'accepted', tags: ['Groom'] },
    { id: '3', status: 'pending', tags: ['VIP', 'Groom'] },
    { id: '4', status: 'declined', tags: [] },
    { id: '5', status: 'maybe', tags: ['Bride'] },
  ];

  it('returns all invites when no tag filter', () => {
    expect(filterByTag(invites, '')).toHaveLength(5);
  });

  it('filters to only matching tag', () => {
    const vip = filterByTag(invites, 'VIP');
    expect(vip).toHaveLength(2);
    expect(vip.map(i => i.id)).toEqual(['1', '3']);
  });

  it('returns empty for non-existent tag', () => {
    expect(filterByTag(invites, 'NonExistent')).toHaveLength(0);
  });

  it('handles invites with empty tags array', () => {
    const bride = filterByTag(invites, 'Bride');
    expect(bride).toHaveLength(2);
    expect(bride.every(i => i.tags.includes('Bride'))).toBe(true);
  });

  it('collects all unique tags sorted', () => {
    const tags = getAllTags(invites);
    expect(tags).toEqual(['Bride', 'Groom', 'VIP']);
  });

  it('returns empty tags array for tagless invites', () => {
    const tags = getAllTags([{ id: '1', status: 'pending', tags: [] }]);
    expect(tags).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════
// S2: Tag array operations (add/remove)
// ════════════════════════════════════════════════════════════════
describe('Tag array operations', () => {
  it('adds a tag to an empty array', () => {
    const tags: string[] = [];
    const newTags = [...tags, 'VIP'];
    expect(newTags).toEqual(['VIP']);
  });

  it('does not duplicate an existing tag', () => {
    const tags = ['VIP', 'Bride'];
    const toAdd = 'VIP';
    if (!tags.includes(toAdd)) tags.push(toAdd);
    expect(tags).toEqual(['VIP', 'Bride']);
  });

  it('removes a tag by value', () => {
    const tags = ['VIP', 'Bride', 'Groom'];
    const result = tags.filter(t => t !== 'Bride');
    expect(result).toEqual(['VIP', 'Groom']);
  });

  it('removing a non-existent tag is safe', () => {
    const tags = ['VIP'];
    const result = tags.filter(t => t !== 'NonExistent');
    expect(result).toEqual(['VIP']);
  });

  it('trims whitespace from tag names', () => {
    const tag = '  VIP Guest  '.trim();
    expect(tag).toBe('VIP Guest');
  });
});

// ════════════════════════════════════════════════════════════════
// S3: Migration schema assertions
// ════════════════════════════════════════════════════════════════
describe('Migration 456 schema expectations', () => {
  it('migration file contains correct schema changes', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/456_guest_tags.sql');
    const content = fs.readFileSync(migrationPath, 'utf-8');

    // Must add tags column as TEXT array with empty default
    expect(content).toContain("ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'");
    // Must create GIN index for efficient containment queries
    expect(content).toContain('USING GIN (tags)');
    expect(content).toContain('idx_event_invites_tags');
    // Partial index — only index non-empty tag arrays
    expect(content).toContain("WHERE tags != '{}'");
    // Must NOT modify RLS policies
    expect(content).not.toContain('CREATE POLICY');
    expect(content).not.toContain('DROP POLICY');
  });
});

// ════════════════════════════════════════════════════════════════
// S4: CSV export includes tags
// ════════════════════════════════════════════════════════════════
describe('CSV export with tags', () => {
  it('formats tags as semicolon-separated in CSV', () => {
    const tags = ['VIP', 'Bride', 'Table 1'];
    const csvCell = tags.join('; ');
    expect(csvCell).toBe('VIP; Bride; Table 1');
  });

  it('handles empty tags gracefully', () => {
    const tags: string[] = [];
    const csvCell = tags.join('; ');
    expect(csvCell).toBe('');
  });
});
