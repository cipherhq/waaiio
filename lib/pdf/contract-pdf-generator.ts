import PDFDocument from 'pdfkit';

interface ContractPdfData {
  businessName: string;
  title: string;
  documentContent: string;
  signerName: string;
  signatureData: string; // base64 data URI
  signedAt: string;      // ISO date
  auditTrail: {
    ip: string;
    user_agent: string;
    device_type: string;
    signed_at: string;
  };
  contractId: string;
}

function collectPdfBuffer(doc: PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export async function generateSignedContractPdf(data: ContractPdfData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const bufferPromise = collectPdfBuffer(doc);

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 100; // 50px margins

  // ── Header ──
  doc.fontSize(10).font('Helvetica').fillColor('#666666')
    .text(data.businessName, 50, 50, { width: contentWidth });

  doc.fontSize(18).font('Helvetica-Bold').fillColor('#000000')
    .text(data.title, 50, 70, { width: contentWidth });

  doc.fontSize(9).font('Helvetica').fillColor('#888888')
    .text(`Date: ${formatDate(data.signedAt)}  |  Ref: ${data.contractId}`, 50, 95, { width: contentWidth });

  // Divider
  doc.moveTo(50, 115).lineTo(pageWidth - 50, 115).strokeColor('#cccccc').stroke();

  // ── Document Body ──
  let y = 130;
  doc.fontSize(10).font('Helvetica').fillColor('#000000');

  const paragraphs = data.documentContent.split('\n');
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();

    // Check page space — estimate line count for pagination
    const estimatedHeight = trimmed.length === 0 ? 10 : (Math.ceil(trimmed.length / 90) * 14) + 4;
    if (y + estimatedHeight > doc.page.height - 120) {
      doc.addPage();
      y = 50;
    }

    if (trimmed.length === 0) {
      y += 10;
      continue;
    }

    // Detect headings (all-caps lines or numbered section headers)
    const isHeading = trimmed === trimmed.toUpperCase() && trimmed.length > 3 && /[A-Z]/.test(trimmed);

    if (isHeading) {
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000');
      doc.text(trimmed, 50, y, { width: contentWidth });
      y += (Math.ceil(trimmed.length / 75) * 16) + 8;
      doc.fontSize(10).font('Helvetica');
    } else {
      doc.fontSize(10).font('Helvetica').fillColor('#000000');
      doc.text(trimmed, 50, y, { width: contentWidth });
      y += (Math.ceil(trimmed.length / 90) * 14) + 4;
    }
  }

  // ── Signature Block ──
  y += 20;
  if (y + 160 > doc.page.height - 60) {
    doc.addPage();
    y = 50;
  }

  doc.moveTo(50, y).lineTo(pageWidth - 50, y).strokeColor('#cccccc').stroke();
  y += 15;

  doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000')
    .text('SIGNATURE', 50, y, { width: contentWidth });
  y += 22;

  doc.fontSize(10).font('Helvetica').fillColor('#333333')
    .text(`Signed by: ${data.signerName}`, 50, y);
  y += 18;

  doc.fontSize(9).font('Helvetica').fillColor('#666666')
    .text(`Date & Time: ${formatDate(data.signedAt)}`, 50, y);
  y += 20;

  // Embed signature image
  try {
    const base64 = data.signatureData.replace(/^data:image\/\w+;base64,/, '');
    const sigBuffer = Buffer.from(base64, 'base64');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (doc as any).image(sigBuffer, 50, y, { width: 200, height: 80 });
    y += 90;
  } catch {
    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#999999')
      .text('[Signature on file]', 50, y);
    y += 18;
  }

  // Signature line
  doc.moveTo(50, y).lineTo(250, y).strokeColor('#000000').stroke();
  y += 5;
  doc.fontSize(8).font('Helvetica').fillColor('#666666')
    .text(data.signerName, 50, y);
  y += 20;

  // ── Audit Trail Footer ──
  if (y + 60 > doc.page.height - 40) {
    doc.addPage();
    y = 50;
  }

  doc.moveTo(50, y).lineTo(pageWidth - 50, y).strokeColor('#eeeeee').stroke();
  y += 10;

  doc.fontSize(7).font('Helvetica').fillColor('#999999');
  doc.text(`Electronically signed via waaiio WhatsApp Sign`, 50, y, { width: contentWidth });
  y += 12;
  doc.text(`IP Address: ${data.auditTrail.ip}`, 50, y);
  y += 10;
  doc.text(`Device: ${data.auditTrail.device_type} | User Agent: ${data.auditTrail.user_agent.slice(0, 80)}`, 50, y);
  y += 10;
  doc.text(`Document ID: ${data.contractId}`, 50, y);

  doc.end();
  return bufferPromise;
}
