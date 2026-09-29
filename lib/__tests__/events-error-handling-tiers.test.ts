import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Source-code contract tests for app/dashboard/events/page.tsx
 *
 * Since this is a 'use client' React component, we verify behaviour contracts
 * by asserting on the source code patterns. This ensures:
 * - All Supabase mutations check for errors
 * - Error messages are surfaced via alert()
 * - Pending ticket types are buffered and flushed correctly
 * - Duplication copies tier definitions
 */

const src = readFileSync(
  join(process.cwd(), 'app/dashboard/events/page.tsx'),
  'utf-8'
);

describe('Events page: error handling contracts', () => {
  describe('handleSave — create path', () => {
    it('captures insert error and alerts on failure', () => {
      // insert must destructure error
      expect(src).toMatch(/const\s*\{\s*data:\s*newEvent,\s*error:\s*insertError\s*\}\s*=\s*await\s+supabase\.from\('events'\)\.insert\(payload\)\.select\('id'\)\.single\(\)/);
      // must alert with insertError.message
      expect(src).toContain("alert(`Failed to create event: ${insertError.message}`)");
      // must return early after alert
      expect(src).toMatch(/alert\(`Failed to create event:.*?\);\s*\n\s*setSaving\(false\);\s*\n\s*return;/);
    });

    it('flushes pending ticket types after successful event insert', () => {
      expect(src).toContain('pendingTicketTypes.length > 0 && newEvent?.id');
      expect(src).toContain("event_id: newEvent.id");
      expect(src).toMatch(/supabase\.from\('event_ticket_types'\)\.insert\(tierPayloads\)/);
    });

    it('handles partial tier failure — event created but tiers failed', () => {
      expect(src).toContain('Event created, but ticket tier setup failed:');
      expect(src).toContain('Open the event to add tiers manually.');
    });
  });

  describe('handleSave — update path', () => {
    it('captures update error and alerts on failure', () => {
      expect(src).toMatch(/const\s*\{\s*error:\s*updateError\s*\}\s*=\s*await\s+supabase\.from\('events'\)\.update\(payload\)\.eq\('id',\s*form\.id\)/);
      expect(src).toContain("alert(`Failed to update event: ${updateError.message}`)");
    });

    it('stays in form on update failure (does not setView to list)', () => {
      // After update error alert, must setSaving(false) and return before setView('list')
      expect(src).toMatch(/Failed to update event:.*?\);\s*\n\s*setSaving\(false\);\s*\n\s*return;/);
    });
  });

  describe('handleDelete', () => {
    it('captures delete error and alerts on failure', () => {
      expect(src).toMatch(/const\s*\{\s*error:\s*deleteError\s*\}\s*=\s*await\s+supabase\.from\('events'\)\.delete\(\)\.eq\('id',\s*id\)/);
      expect(src).toContain("alert(`Failed to delete event: ${deleteError.message}`)");
    });

    it('returns early on delete failure', () => {
      expect(src).toMatch(/Failed to delete event:.*?\);\s*\n\s*return;/);
    });
  });

  describe('addTicketType (edit mode)', () => {
    it('captures insert error and alerts', () => {
      // The addTicketType function must check for error
      expect(src).toContain("Failed to add ticket type: ${error.message}");
    });
  });

  describe('removeTicketType (edit mode)', () => {
    it('captures delete error and alerts', () => {
      expect(src).toContain("Failed to remove ticket type: ${error.message}");
    });
  });
});

describe('Events page: ticket tier UX contracts', () => {
  it('defines PendingTicketType interface at module level', () => {
    // Must be defined outside the component function, after TicketType interface
    const interfaceMatch = src.match(/interface PendingTicketType \{/);
    expect(interfaceMatch).toBeTruthy();
    // Should appear before 'export default function EventsPage'
    const interfacePos = src.indexOf('interface PendingTicketType');
    const componentPos = src.indexOf('export default function EventsPage');
    expect(interfacePos).toBeLessThan(componentPos);
  });

  it('has pendingTicketTypes state', () => {
    expect(src).toMatch(/useState<PendingTicketType\[\]>\(\[\]\)/);
  });

  it('openAdd clears pendingTicketTypes', () => {
    // Within openAdd, setPendingTicketTypes must be called with empty array
    expect(src).toMatch(/function openAdd\(\)[\s\S]*?setPendingTicketTypes\(\[\]\)/);
  });

  it('addPendingTicketType buffers a tier client-side', () => {
    expect(src).toMatch(/function addPendingTicketType\(\)/);
    expect(src).toMatch(/setPendingTicketTypes\(prev\s*=>\s*\[\.\.\.prev/);
  });

  it('removePendingTicketType removes by index', () => {
    expect(src).toMatch(/function removePendingTicketType\(index:\s*number\)/);
    expect(src).toMatch(/prev\.filter\(\(_,\s*i\)\s*=>\s*i\s*!==\s*index\)/);
  });

  it('shows ticket types section in both add and edit modes', () => {
    // The section should NOT be gated by view === 'edit'
    expect(src).not.toMatch(/\{view === 'edit' && \(\s*\n\s*<div>\s*\n\s*<label.*Ticket Types/);
    // Should contain the ticket types label without a view gate
    expect(src).toContain('{/* Ticket Types (add + edit) */}');
  });

  it('uses addPendingTicketType in add mode and addTicketType in edit mode', () => {
    expect(src).toMatch(/onClick=\{view === 'add' \? addPendingTicketType : addTicketType\}/);
  });

  it('displays pending ticket types in add mode', () => {
    expect(src).toContain("view === 'add' && pendingTicketTypes.length > 0");
    expect(src).toContain('pendingTicketTypes.map');
  });
});

describe('Events page: duplication copies tiers', () => {
  it('duplicateEvent is async and loads source tiers', () => {
    expect(src).toMatch(/async function duplicateEvent/);
    expect(src).toMatch(/supabase[\s\S]*?\.from\('event_ticket_types'\)[\s\S]*?\.eq\('event_id',\s*event\.id\)/);
    expect(src).toMatch(/\.eq\('is_active',\s*true\)/);
  });

  it('sets pendingTicketTypes from source tiers', () => {
    expect(src).toMatch(/setPendingTicketTypes\(\(sourceTiers \|\| \[\]\)\.map/);
  });

  it('does not carry over tickets_sold (maps only name, price, total_tickets)', () => {
    // The map inside duplicateEvent should only extract name, price, total_tickets
    const dupSection = src.slice(
      src.indexOf('async function duplicateEvent'),
      src.indexOf("setView('add');", src.indexOf('async function duplicateEvent')) + 20
    );
    expect(dupSection).toContain('name: t.name');
    expect(dupSection).toContain('price: t.price');
    expect(dupSection).toContain('total_tickets: t.total_tickets');
    expect(dupSection).not.toContain('tickets_sold: t.tickets_sold');
  });
});

describe('Events page: cancel-event API path preserved', () => {
  it('uses /api/events/cancel for status=cancelled on existing events', () => {
    expect(src).toContain("fetch('/api/events/cancel'");
    expect(src).toContain("form.status === 'cancelled'");
  });
});
