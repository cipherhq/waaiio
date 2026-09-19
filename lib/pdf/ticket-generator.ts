import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { isWhiteLabel } from '@/lib/whitelabel';
import { formatCurrency, formatCurrencyCode, type CountryCode } from '@/lib/constants';

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
  // New optional fields for enhanced ticket
  flyerUrl?: string;       // event flyer image URL
  ticketType?: string;     // e.g. "VIP", "General Admission"
  price?: number;          // ticket price (authoritative ticket-type or event price)
  countryCode?: string;    // fallback for currency formatting
  currencyCode?: string;   // authoritative ISO 4217 code from payments.currency
  section?: string;        // optional section
  row?: string;            // optional row
  seat?: string;           // optional seat
}

// Brand colors
const BRAND_PURPLE = '#6C2BD9';
const BRAND_PURPLE_LIGHT = '#9F67FF';
const BRAND_DARK = '#240D55';
const TEXT_PRIMARY = '#1a1a1a';
const TEXT_SECONDARY = '#555555';
const TEXT_MUTED = '#888888';
const DIVIDER = '#e0e0e0';

function collectPdfBuffer(doc: PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export async function generateTicketsPdf(opts: TicketPdfOptions): Promise<Buffer> {
  // A5 landscape: 595.28 x 419.53 points
  const pageWidth = 595.28;
  const pageHeight = 419.53;
  const margin = 32;

  // Cast to any — PDFKit's TS types don't expose save/restore/dash/roundedRect/etc.
  const doc: any = new PDFDocument({
    size: [pageWidth, pageHeight],
    margin,
  });
  const bufferPromise = collectPdfBuffer(doc);

  // Try to fetch event flyer for background
  let flyerBuffer: Buffer | null = null;
  if (opts.flyerUrl) {
    flyerBuffer = await fetchImageBuffer(opts.flyerUrl);
  }

  // Try to fetch Waaiio logo for no-flyer fallback
  let logoBuffer: Buffer | null = null;
  const logoUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/logo.png`;
  logoBuffer = await fetchImageBuffer(logoUrl);

  for (let i = 0; i < opts.tickets.length; i++) {
    const ticket = opts.tickets[i];

    if (i > 0) doc.addPage({ size: [pageWidth, pageHeight], margin });

    const contentWidth = pageWidth - margin * 2;

    // ── Background ──
    if (flyerBuffer) {
      // Event flyer as full-page background with opacity overlay
      try {
        doc.save();
        doc.opacity(0.12);
        doc.image(flyerBuffer, 0, 0, { width: pageWidth, height: pageHeight, cover: [pageWidth, pageHeight] });
        doc.restore();
      } catch {
        // Flyer render failed — continue without
      }
    } else {
      // Waaiio-branded fallback: subtle gradient effect via colored rectangles
      doc.rect(0, 0, pageWidth, pageHeight).fillColor('#faf8ff').fill();
      // Subtle diagonal brand accent
      doc.save();
      doc.opacity(0.04);
      doc.rect(pageWidth - 200, 0, 200, pageHeight).fillColor(BRAND_PURPLE).fill();
      doc.restore();
    }

    // ── Top accent bar (brand gradient) ──
    doc.rect(0, 0, pageWidth, 5).fillColor(BRAND_PURPLE).fill();
    doc.rect(pageWidth * 0.6, 0, pageWidth * 0.4, 5).fillColor(BRAND_PURPLE_LIGHT).fill();

    // ── LEFT SIDE: Event info ──
    const leftWidth = contentWidth * 0.62;
    let y = margin + 14;

    // Waaiio logo (small, top-left — shown on all tickets, subject to white-label)
    if (logoBuffer && !isWhiteLabel(opts.subscriptionTier)) {
      try {
        doc.image(logoBuffer, margin, y, { width: 72, height: 17 });
        y += 24;
      } catch { /* skip */ }
    }

    // Event Name
    doc.fontSize(20).font('Helvetica-Bold').fillColor(TEXT_PRIMARY)
      .text(opts.eventName, margin, y, { width: leftWidth });
    y += doc.heightOfString(opts.eventName, { width: leftWidth, fontSize: 20 }) + 8;

    // Ticket type badge (if provided)
    if (opts.ticketType) {
      const badgeWidth = doc.widthOfString(opts.ticketType, { fontSize: 9 }) + 16;
      doc.roundedRect(margin, y, badgeWidth, 18, 4).fillColor(BRAND_PURPLE).fill();
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff')
        .text(opts.ticketType.toUpperCase(), margin + 8, y + 4);
      y += 26;
    }

    // Divider
    doc.moveTo(margin, y).lineTo(margin + leftWidth, y).strokeColor(DIVIDER).lineWidth(0.5).stroke();
    y += 12;

    // Detail rows
    const detailFontSize = 10;
    const detailLineHeight = 20;

    const detailRows: [string, string][] = [
      ['DATE', opts.eventDate],
    ];
    if (opts.eventTime) detailRows.push(['TIME', opts.eventTime]);
    if (opts.venue) detailRows.push(['VENUE', opts.venue]);
    detailRows.push(['ATTENDEE', opts.guestName]);
    detailRows.push(['REF', opts.referenceCode]);
    if (opts.price !== undefined && opts.price > 0) {
      const priceStr = opts.currencyCode
        ? formatCurrencyCode(opts.price, opts.currencyCode)
        : formatCurrency(opts.price, (opts.countryCode || 'NG') as CountryCode);
      detailRows.push(['PRICE', priceStr]);
    }
    // Section/Row/Seat
    const seatParts: string[] = [];
    if (opts.section) seatParts.push(`Sec ${opts.section}`);
    if (opts.row) seatParts.push(`Row ${opts.row}`);
    if (opts.seat) seatParts.push(`Seat ${opts.seat}`);
    if (seatParts.length > 0) {
      detailRows.push(['SEAT', seatParts.join(' · ')]);
    }

    for (const [label, value] of detailRows) {
      doc.fontSize(7).font('Helvetica-Bold').fillColor(TEXT_MUTED)
        .text(label, margin, y);
      doc.fontSize(detailFontSize).font('Helvetica').fillColor(TEXT_PRIMARY)
        .text(value, margin + 60, y, { width: leftWidth - 60 });
      y += detailLineHeight;
    }

    // Ticket count
    y += 4;
    doc.fontSize(9).font('Helvetica').fillColor(TEXT_SECONDARY)
      .text(`Ticket ${ticket.ticketNumber} of ${ticket.totalTickets}`, margin, y);

    // ── RIGHT SIDE: QR code + ticket code ──
    const rightX = margin + leftWidth + 20;
    const rightWidth = contentWidth - leftWidth - 20;

    // Vertical dashed divider
    const dashY = margin + 14;
    const dashEnd = pageHeight - margin - 30;
    doc.save();
    doc.dash(4, { space: 3 });
    doc.moveTo(rightX - 10, dashY).lineTo(rightX - 10, dashEnd).strokeColor('#d0d0d0').lineWidth(0.5).stroke();
    doc.restore();
    doc.undash();

    // QR Code (centered in right column)
    const qrUrl = `${opts.verifyBaseUrl}/${ticket.ticketCode}`;
    const qrSize = Math.min(rightWidth - 16, 130);
    const qrX = rightX + (rightWidth - qrSize) / 2;
    const qrY = margin + 40;

    try {
      const qrDataUrl = await QRCode.toDataURL(qrUrl, {
        width: qrSize * 2,
        margin: 1,
        color: { dark: BRAND_DARK, light: '#ffffff' },
      });
      const qrBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
      const qrBuffer = Buffer.from(qrBase64, 'base64');

      // White background for QR
      doc.roundedRect(qrX - 8, qrY - 8, qrSize + 16, qrSize + 16, 8)
        .fillColor('#ffffff').fill();
      doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
    } catch {
      doc.fontSize(8).fillColor(TEXT_MUTED)
        .text(qrUrl, qrX, qrY, { width: qrSize });
    }

    // "Scan to verify" label
    const scanY = qrY + qrSize + 16;
    doc.fontSize(8).font('Helvetica').fillColor(TEXT_MUTED)
      .text('Scan to verify', rightX, scanY, { width: rightWidth, align: 'center' });

    // Ticket code badge
    const codeY = scanY + 20;
    const codeWidth = doc.widthOfString(ticket.ticketCode, { fontSize: 13 }) + 20;
    const codeX = rightX + (rightWidth - codeWidth) / 2;
    doc.roundedRect(codeX, codeY, codeWidth, 24, 6)
      .fillColor(BRAND_PURPLE).opacity(0.1).fill();
    doc.opacity(1);
    doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_PURPLE)
      .text(ticket.ticketCode, codeX, codeY + 6, { width: codeWidth, align: 'center' });

    // ── Footer ──
    const footerY = pageHeight - margin - 6;
    if (!isWhiteLabel(opts.subscriptionTier)) {
      doc.fontSize(7).font('Helvetica').fillColor('#bbbbbb')
        .text('Powered by Waaiio  ·  waaiio.com', margin, footerY, { width: contentWidth, align: 'center' });
    }
  }

  doc.end();
  return bufferPromise;
}
