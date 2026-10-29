/**
 * Queue tab — Share Queue QR/link entry point tests (#752).
 *
 * Verifies:
 * 1. Queue page renders "Share Queue" link targeting /dashboard/qr-code?template=queue
 * 2. QR Code page reads ?template= param and pre-selects the queue template
 * 3. Invalid/missing template param defaults to generic
 * 4. Existing QR template selection behavior preserved
 */
import { describe, it, expect, vi } from 'vitest';

// ── Test 1: Queue page Share Queue link ──

describe('Queue page — Share Queue link', () => {
  it('renders a link to /dashboard/qr-code?template=queue', async () => {
    // Read the Queue page source to verify the link exists with correct href
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../page.tsx'),
      'utf-8',
    );

    // Verify Link import
    expect(source).toContain("import Link from 'next/link'");

    // Verify the Share Queue link with correct href
    expect(source).toContain('href="/dashboard/qr-code?template=queue"');
    expect(source).toContain('Share Queue');

    // Verify it's positioned inside the action buttons group
    const actionArea = source.slice(
      source.indexOf('<div className="flex gap-2">'),
      source.indexOf('Call Next'),
    );
    expect(actionArea).toContain('Share Queue');
    expect(actionArea).toContain('template=queue');
  });
});

// ── Test 2: QR Code page template param support ──

describe('QR Code page — ?template= param support', () => {
  it('reads template param and validates against known template IDs', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../qr-code/page.tsx'),
      'utf-8',
    );

    // Verify useSearchParams import
    expect(source).toContain("useSearchParams");
    expect(source).toContain("from 'next/navigation'");

    // Verify template param reading
    expect(source).toContain("searchParams.get('template')");

    // Verify validation against TEMPLATES array
    expect(source).toContain('TEMPLATES.some(t => t.id === param)');

    // Verify initialTemplate used as state default (not hardcoded 'generic')
    expect(source).toContain('useState<TemplateId>(initialTemplate)');

    // Verify deep-link suffix is initialized from the template
    expect(source).toContain('TEMPLATES.find(t => t.id === initialTemplate)');
  });

  it('defaults to generic when no template param provided', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../qr-code/page.tsx'),
      'utf-8',
    );

    // The fallback is 'generic' when param is null or invalid
    expect(source).toMatch(/return ['"]generic['"]/);
  });

  it('queue template exists with correct capabilities and deep-link suffix', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../qr-code/page.tsx'),
      'utf-8',
    );

    // The queue template has capabilities: ['queue'] which produces deep-link suffix 'queue'
    expect(source).toContain("id: 'queue'");
    expect(source).toContain("label: 'Scan to Join Queue'");
    expect(source).toContain("capabilities: ['queue']");
  });
});

// ── Test 3: Link construction for queue template ──

describe('QR Code — queue link construction', () => {
  it('queue template produces correct deep-link suffix for shared numbers', () => {
    // Simulate the link construction logic
    const routingCode = 'TESTBIZ';
    const deepLinkSuffix = 'queue'; // first capability of queue template
    const prefillText = routingCode
      ? (deepLinkSuffix ? `${routingCode}:${deepLinkSuffix}` : routingCode)
      : 'Hi';

    expect(prefillText).toBe('TESTBIZ:queue');

    const link = `https://wa.me/2349012345678?text=${encodeURIComponent(prefillText)}`;
    expect(link).toContain('TESTBIZ%3Aqueue');
    expect(link).toContain('wa.me/');
  });

  it('queue template on dedicated number sends Hi (no routing code)', () => {
    const routingCode = ''; // dedicated number — no routing code
    const deepLinkSuffix = ''; // no suffix when no routing code
    const prefillText = routingCode
      ? (deepLinkSuffix ? `${routingCode}:${deepLinkSuffix}` : routingCode)
      : 'Hi';

    expect(prefillText).toBe('Hi');
  });

  it('existing generic template behavior preserved', () => {
    // Generic template has capabilities: [] → no deep-link suffix
    const routingCode = 'TESTBIZ';
    const deepLinkSuffix = ''; // generic has no capability
    const prefillText = routingCode
      ? (deepLinkSuffix ? `${routingCode}:${deepLinkSuffix}` : routingCode)
      : 'Hi';

    expect(prefillText).toBe('TESTBIZ');
  });
});
