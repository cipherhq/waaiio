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

    it('handles partial tier failure — transitions to recovery mode', () => {
      expect(src).toContain('Event created, but ticket tier setup failed:');
      expect(src).toContain('click "Retry Ticket Tiers" below');
      // Must set recovery flag and transition to edit mode with the new event ID
      expect(src).toMatch(/setForm\(prev\s*=>\s*\(\{\s*\.\.\.prev,\s*id:\s*newEvent\.id\s*\}\)\)/);
      expect(src).toContain('setTierRecoveryPending(true)');
      expect(src).toContain("setView('edit')");
      // pendingTicketTypes must NOT be cleared — preserved for retry
      const partialSection = src.slice(
        src.indexOf('Event created, but ticket tier setup failed:'),
        src.indexOf('setPendingTicketTypes([])', src.indexOf('Event created, but ticket tier setup failed:'))
      );
      expect(partialSection).not.toContain('setPendingTicketTypes([])');
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
  it('defines PendingTicketType interface at module level with all approved fields', () => {
    const interfaceMatch = src.match(/interface PendingTicketType \{/);
    expect(interfaceMatch).toBeTruthy();
    const interfacePos = src.indexOf('interface PendingTicketType');
    const componentPos = src.indexOf('export default function EventsPage');
    expect(interfacePos).toBeLessThan(componentPos);
    // Must include sort_order and is_active (optional for manually added tiers)
    const interfaceBlock = src.slice(interfacePos, src.indexOf('}', interfacePos) + 1);
    expect(interfaceBlock).toContain('sort_order');
    expect(interfaceBlock).toContain('is_active');
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

  it('displays pending ticket types in add mode and recovery mode', () => {
    expect(src).toContain("(view === 'add' || tierRecoveryPending) && pendingTicketTypes.length > 0");
    expect(src).toContain('pendingTicketTypes.map');
  });
});

describe('Events page: duplication copies tiers', () => {
  it('duplicateEvent is async and loads source tiers', () => {
    expect(src).toMatch(/async function duplicateEvent/);
    expect(src).toMatch(/supabase[\s\S]*?\.from\('event_ticket_types'\)[\s\S]*?\.eq\('event_id',\s*event\.id\)/);
    expect(src).toMatch(/\.eq\('is_active',\s*true\)/);
  });

  it('sets pendingTicketTypes from source tiers on success', () => {
    expect(src).toMatch(/setPendingTicketTypes\(\(sourceTiers \|\| \[\]\)\.map/);
  });

  it('copies all approved tier definition fields and excludes tickets_sold', () => {
    const dupSection = src.slice(
      src.indexOf('async function duplicateEvent'),
      src.indexOf("setView('add');", src.indexOf('async function duplicateEvent')) + 20
    );
    expect(dupSection).toContain('name: t.name');
    expect(dupSection).toContain('price: t.price');
    expect(dupSection).toContain('total_tickets: t.total_tickets');
    expect(dupSection).toContain('sort_order: t.sort_order');
    expect(dupSection).toContain('is_active: t.is_active');
    expect(dupSection).not.toContain('tickets_sold: t.tickets_sold');
  });

  it('fails closed on source-tier load failure — does not enter duplicate creation state', () => {
    const dupSection = src.slice(
      src.indexOf('async function duplicateEvent'),
      src.indexOf("setView('add');", src.indexOf('async function duplicateEvent')) + 20
    );
    expect(dupSection).toContain('tierLoadError');
    expect(dupSection).toContain('Failed to load ticket tiers from source event:');
    expect(dupSection).toContain('Cannot duplicate until tiers are loaded.');
    // Must return before setForm/setView — fail closed
    const errorIdx = dupSection.indexOf('tierLoadError)');
    const returnIdx = dupSection.indexOf('return;', errorIdx);
    const setFormIdx = dupSection.indexOf('setForm(', errorIdx);
    expect(returnIdx).toBeLessThan(setFormIdx); // return before setForm
  });
});

describe('Events page: tier flush preserves sort_order and is_active', () => {
  it('flush payload uses sort_order from pending type with fallback to index', () => {
    expect(src).toContain('sort_order: t.sort_order ?? i');
  });

  it('flush payload uses is_active from pending type with fallback to true', () => {
    expect(src).toContain('is_active: t.is_active ?? true');
  });
});

describe('Events page: tier recovery mechanism', () => {
  it('has tierRecoveryPending state flag', () => {
    expect(src).toContain('tierRecoveryPending');
    expect(src).toMatch(/useState.*false.*tierRecoveryPending|tierRecoveryPending.*useState/);
  });

  it('retryPendingTiers function exists and inserts against existing event ID', () => {
    expect(src).toMatch(/async function retryPendingTiers\(\)/);
    const retrySection = src.slice(
      src.indexOf('async function retryPendingTiers'),
      src.indexOf('}', src.indexOf('loadTicketTypes(form.id)', src.indexOf('async function retryPendingTiers'))) + 1
    );
    // Uses form.id (the existing event ID)
    expect(retrySection).toContain('event_id: form.id');
    // Does NOT create the event again
    expect(retrySection).not.toContain("from('events').insert");
  });

  it('retry success clears pending buffer and loads persisted tiers', () => {
    const retrySection = src.slice(
      src.indexOf('async function retryPendingTiers'),
      src.indexOf('}', src.indexOf('loadTicketTypes(form.id)', src.indexOf('async function retryPendingTiers'))) + 1
    );
    expect(retrySection).toContain('setPendingTicketTypes([])');
    expect(retrySection).toContain('setTierRecoveryPending(false)');
    expect(retrySection).toContain('loadTicketTypes(form.id)');
  });

  it('retry failure keeps pending tiers intact and surfaces error', () => {
    const retrySection = src.slice(
      src.indexOf('async function retryPendingTiers'),
      src.indexOf('}', src.indexOf('loadTicketTypes(form.id)', src.indexOf('async function retryPendingTiers'))) + 1
    );
    expect(retrySection).toContain('Ticket tier setup failed again:');
    // Error path returns before clearing pending types
    const errorIdx = retrySection.indexOf('Ticket tier setup failed again:');
    const returnIdx = retrySection.indexOf('return;', errorIdx);
    const clearIdx = retrySection.indexOf('setPendingTicketTypes([])', errorIdx);
    expect(returnIdx).toBeLessThan(clearIdx); // return before clear
  });

  it('pending tiers are visible in recovery mode (edit + tierRecoveryPending)', () => {
    // The pending tier list renders when tierRecoveryPending is true
    expect(src).toContain("(view === 'add' || tierRecoveryPending) && pendingTicketTypes.length > 0");
  });

  it('shows Retry Ticket Tiers button in recovery mode', () => {
    expect(src).toContain('Retry Ticket Tiers');
    expect(src).toContain('retryPendingTiers');
  });

  it('recovery banner surfaces tier failure message', () => {
    expect(src).toContain('Ticket tiers failed to save. Your definitions are preserved below.');
  });

  it('openAdd and openEdit clear recovery state', () => {
    // openAdd clears tierRecoveryPending
    const addSection = src.slice(src.indexOf('function openAdd'), src.indexOf("setView('add')", src.indexOf('function openAdd')) + 20);
    expect(addSection).toContain('setTierRecoveryPending(false)');
    // openEdit clears tierRecoveryPending
    const editSection = src.slice(src.indexOf('function openEdit'), src.indexOf("setView('edit')", src.indexOf('function openEdit')) + 20);
    expect(editSection).toContain('setTierRecoveryPending(false)');
  });
});

describe('Events page: cancel-event API path preserved', () => {
  it('uses /api/events/cancel for status=cancelled on existing events', () => {
    expect(src).toContain("fetch('/api/events/cancel'");
    expect(src).toContain("form.status === 'cancelled'");
  });
});
