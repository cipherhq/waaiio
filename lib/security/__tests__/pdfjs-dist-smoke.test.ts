/**
 * pdfjs-dist v6 smoke test — verifies the library can parse a real PDF.
 *
 * The app uses pdfjs-dist only in app/sign/[token]/page.tsx (client-side
 * dynamic import for contract signing). This test confirms the v6 API
 * (getDocument, numPages, getPage, getTextContent) works in Node.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';

describe('pdfjs-dist v6 smoke', () => {
  it('parses a small PDF and extracts page count and text', async () => {
    // Create a minimal PDF with pdf-lib
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([200, 200]);
    page.drawText('Hello smoke test', { x: 10, y: 100, size: 12, font });
    const pdfBytes = await doc.save();

    // Parse it with pdfjs-dist legacy build (Node.js requires legacy;
    // the app uses the default build in the browser via dynamic import)
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes) });
    const pdf = await loadingTask.promise;

    expect(pdf.numPages).toBe(1);

    const p1 = await pdf.getPage(1);
    const viewport = p1.getViewport({ scale: 1 });
    expect(viewport.width).toBeGreaterThan(0);
    expect(viewport.height).toBeGreaterThan(0);

    const textContent = await p1.getTextContent();
    const text = textContent.items.map((i: { str?: string }) => i.str ?? '').join('');
    expect(text).toContain('Hello smoke test');
  });
});
