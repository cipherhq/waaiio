import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { isWhiteLabel } from '@/lib/whitelabel';

export interface TicketPdfOptions {
  eventName: string;
  eventDate: string;       // formatted date string, e.g. "Saturday, 25 January 2025"
  eventTime?: string;      // e.g. "7:00 PM"
  venue: string;
  guestName: string;
  referenceCode: string;
  tickets: Array<{
    ticketCode: string;
    ticketNumber: number;
    totalTickets: number;
  }>;
  verifyBaseUrl: string;   // derived from NEXT_PUBLIC_APP_URL env var
  subscriptionTier?: string;
}

function collectPdfBuffer(doc: PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

export async function generateTicketsPdf(opts: TicketPdfOptions): Promise<Buffer> {
  // A5 landscape: 595.28 x 419.53 points
  const pageWidth = 595.28;
  const pageHeight = 419.53;
  const margin = 40;

  const doc = new PDFDocument({
    size: [pageWidth, pageHeight],
    margin,
  });
  const bufferPromise = collectPdfBuffer(doc);

  for (let i = 0; i < opts.tickets.length; i++) {
    const ticket = opts.tickets[i];

    if (i > 0) doc.addPage({ size: [pageWidth, pageHeight], margin });

    const contentWidth = pageWidth - margin * 2;

    // ── Background accent bar ──
    doc.rect(0, 0, pageWidth, 6).fillColor('#7c3aed').fill();

    // ── Event Name ──
    let y = margin + 10;
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#1a1a1a')
      .text(opts.eventName, margin, y, { width: contentWidth });
    y += 34;

    // ── Divider ──
    doc.moveTo(margin, y).lineTo(pageWidth - margin, y).strokeColor('#e5e5e5').stroke();
    y += 14;

    // ── Event details ──
    doc.fontSize(11).font('Helvetica').fillColor('#444444');

    doc.font('Helvetica-Bold').text('Date:', margin, y, { continued: true })
      .font('Helvetica').text(`  ${opts.eventDate}`);
    y += 18;

    if (opts.eventTime) {
      doc.font('Helvetica-Bold').text('Time:', margin, y, { continued: true })
        .font('Helvetica').text(`  ${opts.eventTime}`);
      y += 18;
    }

    if (opts.venue) {
      doc.font('Helvetica-Bold').text('Venue:', margin, y, { continued: true })
        .font('Helvetica').text(`  ${opts.venue}`);
      y += 18;
    }

    y += 6;

    // ── Guest & ticket info ──
    doc.font('Helvetica-Bold').text('Guest:', margin, y, { continued: true })
      .font('Helvetica').text(`  ${opts.guestName}`);
    y += 18;

    doc.font('Helvetica-Bold').text('Ticket:', margin, y, { continued: true })
      .font('Helvetica').text(`  ${ticket.ticketNumber} of ${ticket.totalTickets}`);
    y += 18;

    doc.font('Helvetica-Bold').text('Ref:', margin, y, { continued: true })
      .font('Helvetica').text(`  ${opts.referenceCode}`);
    y += 26;

    // ── QR Code ──
    const qrUrl = `${opts.verifyBaseUrl}/${ticket.ticketCode}`;
    const qrSize = 120;
    const qrX = margin;
    const qrY = y;

    try {
      const qrDataUrl = await QRCode.toDataURL(qrUrl, {
        width: qrSize * 2,   // render at 2x for sharpness
        margin: 1,
        color: { dark: '#1a1a1a', light: '#ffffff' },
      });
      // Convert data URL to buffer
      const qrBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
      const qrBuffer = Buffer.from(qrBase64, 'base64');
      (doc as any).image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
    } catch {
      // Fallback: show URL as text if QR generation fails
      doc.fontSize(8).fillColor('#999999')
        .text(qrUrl, qrX, qrY, { width: qrSize });
    }

    // ── Scan instructions next to QR ──
    const textX = qrX + qrSize + 16;
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#7c3aed')
      .text('Scan to verify', textX, qrY + 10);
    doc.fontSize(9).font('Helvetica').fillColor('#888888')
      .text('ticket authenticity', textX, qrY + 26);

    // Ticket code below instructions
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a1a1a')
      .text(ticket.ticketCode, textX, qrY + 50);

    // ── Footer ──
    const footerY = pageHeight - margin - 10;
    doc.moveTo(margin, footerY - 8).lineTo(pageWidth - margin, footerY - 8)
      .strokeColor('#e5e5e5').stroke();
    if (!isWhiteLabel(opts.subscriptionTier)) {
      doc.fontSize(8).font('Helvetica').fillColor('#bbbbbb')
        .text('Powered by Waaiio', margin, footerY, { width: contentWidth, align: 'center' });
    }
  }

  doc.end();
  return bufferPromise;
}
