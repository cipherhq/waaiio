import { describe, expect, it } from 'vitest';

describe('PDFKit built-in font loading', () => {
  it('creates a PDF using Helvetica and Helvetica-Bold without ENOENT', async () => {
    const PDFDocument = (await import('pdfkit')).default;
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    const completed = new Promise<void>((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
    });

    // These built-in fonts load AFM files from pdfkit/js/data at runtime.
    // This is the production path that previously failed when PDFKit was bundled
    // under .next/server/chunks and __dirname no longer pointed at node_modules.
    doc.font('Helvetica-Bold').fontSize(12).text('Waaiio receipt');
    doc.font('Helvetica').text('PDFKit font packaging regression proof');
    doc.end();

    await completed;

    const buffer = Buffer.concat(chunks);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.toString('ascii', 0, 5)).toBe('%PDF-');
  });
});
