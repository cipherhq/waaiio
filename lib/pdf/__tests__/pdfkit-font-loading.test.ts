import { describe, it, expect } from 'vitest';

describe('PDFKit font loading', () => {
  it('can create a PDF with Helvetica font without ENOENT', async () => {
    const PDFDocument = (await import('pdfkit')).default;
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    // This is the exact call that fails on Vercel when pdfkit is bundled
    // and __dirname resolves to the chunk directory instead of node_modules/pdfkit/js/
    doc.font('Helvetica-Bold');
    doc.fontSize(12).text('Test');
    doc.font('Helvetica');
    doc.text('Normal text');
    doc.end();

    await new Promise(resolve => doc.on('end', resolve));
    const buffer = Buffer.concat(chunks);
    expect(buffer.length).toBeGreaterThan(0);
    // PDF magic bytes
    expect(buffer.toString('ascii', 0, 5)).toBe('%PDF-');
  });
});
