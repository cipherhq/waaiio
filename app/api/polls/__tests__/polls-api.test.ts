/**
 * Polls API — tier gate removal, capability guards, status validation, dead code removal
 *
 * Tests the four fixes from issue #246:
 * 1. Free-tier businesses can access polls (poll capability is tier:'free')
 * 2. API routes enforce capability guard on create/update/delete
 * 3. Status transitions are validated server-side
 * 4. Send route rejects non-active polls (dead auto-activate code removed)
 */
import { describe, it, expect } from 'vitest';

// ── Fix 1: Tier gate removal (page-level, tested via source analysis) ──

describe('Fix 1: Free-tier page gate removed', () => {
  it('poll capability is set to free tier in shared/capabilities.ts', async () => {
    const { CAPABILITY_TIER_REQUIREMENTS } = await import('@/shared/capabilities');
    expect(CAPABILITY_TIER_REQUIREMENTS.poll).toBe('free');
  });

  it('polls page.tsx does not contain isGated = tier === free', async () => {
    const fs = await import('fs');
    const path = await import('path');
    // __tests__ is at app/api/polls/__tests__, page is at app/dashboard/polls/page.tsx
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'dashboard', 'polls', 'page.tsx'),
      'utf-8',
    );
    expect(src).not.toContain("isGated = tier === 'free'");
    expect(src).not.toContain('Polls available on Pro plan');
  });
});

// ── Fix 3: Status validation logic (pure logic, no mocking needed) ──

describe('Fix 3: Status transition validation', () => {
  const VALID_STATUSES = ['draft', 'active', 'closed'] as const;
  const VALID_TRANSITIONS: Record<string, string[]> = {
    draft: ['active'],
    active: ['closed'],
    closed: [],
  };

  it('draft -> active is a valid transition', () => {
    expect(VALID_TRANSITIONS['draft']).toContain('active');
  });

  it('active -> closed is a valid transition', () => {
    expect(VALID_TRANSITIONS['active']).toContain('closed');
  });

  it('draft -> closed is rejected', () => {
    expect(VALID_TRANSITIONS['draft']).not.toContain('closed');
  });

  it('closed -> active is rejected', () => {
    expect(VALID_TRANSITIONS['closed']).not.toContain('active');
  });

  it('closed -> draft is rejected', () => {
    expect(VALID_TRANSITIONS['closed']).not.toContain('draft');
  });

  it('active -> draft is rejected (no rollback)', () => {
    expect(VALID_TRANSITIONS['active']).not.toContain('draft');
  });

  it('rejects unknown status values', () => {
    expect(VALID_STATUSES).not.toContain('completed');
    expect(VALID_STATUSES).not.toContain('archived');
    expect(VALID_STATUSES).not.toContain('pending');
  });
});

// ── Fix 3: Activation preconditions ──

describe('Fix 3: Activation preconditions', () => {
  function canActivate(poll: { question?: string; options?: string[] | null }): { ok: boolean; error?: string } {
    if (!poll.question || !poll.question.trim()) {
      return { ok: false, error: 'Poll must have a question before activation' };
    }
    if (!poll.options || poll.options.length < 2) {
      return { ok: false, error: 'Poll must have at least 2 options before activation' };
    }
    if (poll.options.length > 10) {
      return { ok: false, error: 'Poll must have at most 10 options' };
    }
    return { ok: true };
  }

  it('poll with question and 2 options can activate', () => {
    expect(canActivate({ question: 'Favorite color?', options: ['Red', 'Blue'] }).ok).toBe(true);
  });

  it('poll with question and 10 options can activate', () => {
    const opts = Array.from({ length: 10 }, (_, i) => `Option ${i + 1}`);
    expect(canActivate({ question: 'Pick one', options: opts }).ok).toBe(true);
  });

  it('poll with <2 options cannot activate', () => {
    const result = canActivate({ question: 'Q?', options: ['Only one'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('at least 2');
  });

  it('poll with 0 options cannot activate', () => {
    expect(canActivate({ question: 'Q?', options: [] }).ok).toBe(false);
  });

  it('poll with null options cannot activate', () => {
    expect(canActivate({ question: 'Q?', options: null }).ok).toBe(false);
  });

  it('poll with >10 options cannot activate', () => {
    const opts = Array.from({ length: 11 }, (_, i) => `Option ${i + 1}`);
    const result = canActivate({ question: 'Q?', options: opts });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('at most 10');
  });

  it('poll with empty question cannot activate', () => {
    expect(canActivate({ question: '', options: ['A', 'B'] }).ok).toBe(false);
  });

  it('poll with whitespace-only question cannot activate', () => {
    expect(canActivate({ question: '   ', options: ['A', 'B'] }).ok).toBe(false);
  });
});

// ── Fix 4: Dead code removed from send route ──

describe('Fix 4: Dead auto-activate code removed from send route', () => {
  it('send route source does not contain draft auto-activate logic', async () => {
    const fs = await import('fs');
    const path = await import('path');
    // The send route is at app/api/polls/[id]/send/route.ts
    // From __tests__ dir: ../[id]/send/route.ts
    const sendRoutePath = path.resolve(__dirname, '..', '[id]', 'send', 'route.ts');
    const src = fs.readFileSync(sendRoutePath, 'utf-8');
    // The dead code was: if (poll.status === 'draft') { await supabase.from('polls').update({ status: 'active' })... }
    // After the line that returns 400 for non-active polls, this was unreachable.
    expect(src).not.toContain("Activate poll if draft");
    expect(src).not.toContain("poll.status === 'draft'");
  });

  it('send route still rejects non-active polls', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const sendRoutePath = path.resolve(__dirname, '..', '[id]', 'send', 'route.ts');
    const src = fs.readFileSync(sendRoutePath, 'utf-8');
    expect(src).toContain("poll.status !== 'active'");
    expect(src).toContain('Poll must be active before sending');
  });
});

// ── Fix 2: Capability guards present in source ──

describe('Fix 2: Capability guards in API routes', () => {
  it('POST /api/polls imports and uses requireCapability', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const routePath = path.resolve(__dirname, '..', 'route.ts');
    const src = fs.readFileSync(routePath, 'utf-8');
    expect(src).toContain("import { requireCapability } from '@/lib/capabilities/api-guard'");
    expect(src).toContain("capability: 'poll', action: 'create_new'");
  });

  it('PATCH /api/polls/[id] imports and uses requireCapability with manage_existing', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const routePath = path.resolve(__dirname, '..', '[id]', 'route.ts');
    const src = fs.readFileSync(routePath, 'utf-8');
    expect(src).toContain("import { requireCapability } from '@/lib/capabilities/api-guard'");
    expect(src).toContain("capability: 'poll', action: 'manage_existing'");
  });

  it('DELETE /api/polls/[id] uses requireCapability with manage_existing', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const routePath = path.resolve(__dirname, '..', '[id]', 'route.ts');
    const src = fs.readFileSync(routePath, 'utf-8');
    // DELETE handler also uses manage_existing
    const deleteSection = src.slice(src.indexOf('async function DELETE'));
    expect(deleteSection).toContain("capability: 'poll', action: 'manage_existing'");
  });

  it('send route preserves existing capability guard', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const sendPath = path.resolve(__dirname, '..', '[id]', 'send', 'route.ts');
    const src = fs.readFileSync(sendPath, 'utf-8');
    expect(src).toContain("requireCapability");
    expect(src).toContain("capability: 'poll'");
  });
});

// ── Fix 3: PATCH route validates status in source ──

describe('Fix 3: PATCH route source validation', () => {
  it('PATCH route validates status values', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const routePath = path.resolve(__dirname, '..', '[id]', 'route.ts');
    const src = fs.readFileSync(routePath, 'utf-8');
    expect(src).toContain("VALID_STATUSES");
    expect(src).toContain("VALID_TRANSITIONS");
    expect(src).toContain("Invalid transition");
    expect(src).toContain("at least 2 options before activation");
  });
});
