import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { isWhiteLabel } from '@/lib/whitelabel';
import { formatCurrency, formatCurrencyCode, type CountryCode } from '@/lib/constants';
import { WORDMARK_PATH, WORDMARK_DISPLAY } from '@/lib/brand';

export interface TicketPdfOptions {
  eventName: string;
  eventDate: string;
  eventTime?: string;
  venue: string;
  guestName: string;
  referenceCode: string;
  tickets: Array<{
    ticketCode: string;
    ticketNumber: number;
    totalTickets: number;
  }>;
  verifyBaseUrl: string;
  subscriptionTier?: string;
  flyerUrl?: string;
  ticketType?: string;
  price?: number;
  countryCode?: string;
  currencyCode?: string;
  section?: string;
  row?: string;
  seat?: string;
  /** Slice 5B: deterministic Waaiio-owned labels selected by authorized language. */
  labels?: import('./localize-pdf').TicketPdfLabels;
}

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
  const { DEFAULT_TICKET_LABELS: TICKET_DEFAULTS } = await import('./localize-pdf');
  const TL = opts.labels || TICKET_DEFAULTS;

  const pageWidth = 595.28;
  const pageHeight = 419.53;
  const margin = 32;
  const doc: any = new PDFDocument({ size: [pageWidth, pageHeight], margin });
  const bufferPromise = collectPdfBuffer(doc);

  let flyerBuffer: Buffer | null = null;
  if (opts.flyerUrl) flyerBuffer = await fetchImageBuffer(opts.flyerUrl);

  let logoBuffer: Buffer | null = null;
  const logoUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}${WORDMARK_PATH}`;
  logoBuffer = await fetchImageBuffer(logoUrl);

  for (let i = 0; i < opts.tickets.length; i++) {
    const ticket = opts.tickets[i];
    if (i > 0) doc.addPage({ size: [pageWidth, pageHeight], margin });

    const contentWidth = pageWidth - margin * 2;
    if (flyerBuffer) {
      try {
        doc.save();
        doc.opacity(0.12);
        doc.image(flyerBuffer, 0, 0, { width: pageWidth, height: pageHeight, cover: [pageWidth, pageHeight] });
        doc.restore();
      } catch { /* continue without flyer */ }
    } else {
      doc.rect(0, 0, pageWidth, pageHeight).fillColor('#faf8ff').fill();
      doc.save();
      doc.opacity(0.04);
      doc.rect(pageWidth - 200, 0, 200, pageHeight).fillColor(BRAND_PURPLE).fill();
      doc.restore();
    }

    doc.rect(0, 0, pageWidth, 5).fillColor(BRAND_PURPLE).fill();
    doc.rect(pageWidth * 0.6, 0, pageWidth * 0.4, 5).fillColor(BRAND_PURPLE_LIGHT).fill();

    const leftWidth = contentWidth * 0.62;
    let y = margin + 14;

    if (logoBuffer && !isWhiteLabel(opts.subscriptionTier)) {
      try {
        doc.image(logoBuffer, margin, y, { width: WORDMARK_DISPLAY.watermark.width, height: WORDMARK_DISPLAY.watermark.height });
        y += 24;
      } catch { /* skip */ }
    }

    doc.fontSize(20).font('Helvetica-Bold').fillColor(TEXT_PRIMARY)
      .text(opts.eventName, margin, y, { width: leftWidth });
    y += doc.heightOfString(opts.eventName, { width: leftWidth, fontSize: 20 }) + 8;

    if (opts.ticketType) {
      const badgeWidth = doc.widthOfString(opts.ticketType, { fontSize: 9 }) + 16;
      doc.roundedRect(margin, y, badgeWidth, 18, 4).fillColor(BRAND_PURPLE).fill();
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff')
        .text(opts.ticketType.toUpperCase(), margin + 8, y + 4);
      y += 26;
    }

    doc.moveTo(margin, y).lineTo(margin + leftWidth, y).strokeColor(DIVIDER).lineWidth(0.5).stroke();
    y += 12;

    const detailFontSize = 10;
    const detailLineHeight = 20;
    const detailRows: [string, string][] = [[TL.lblDate, opts.eventDate]];
    if (opts.eventTime) detailRows.push([TL.lblTime, opts.eventTime]);
    if (opts.venue) detailRows.push([TL.lblVenue, opts.venue]);
    detailRows.push([TL.lblAttendee, opts.guestName]);
    detailRows.push([TL.lblRef, opts.referenceCode]);
    if (opts.price !== undefined && opts.price > 0) {
      const priceStr = opts.currencyCode
        ? formatCurrencyCode(opts.price, opts.currencyCode)
        : formatCurrency(opts.price, (opts.countryCode || 'NG') as CountryCode);
      detailRows.push([TL.lblPrice, priceStr]);
    }

    const seatParts: string[] = [];
    if (opts.section) seatParts.push(`${TL.lblSection} ${opts.section}`);
    if (opts.row) seatParts.push(`${TL.lblRow} ${opts.row}`);
    if (opts.seat) seatParts.push(`${TL.lblSeatNumber} ${opts.seat}`);
    if (seatParts.length > 0) detailRows.push([TL.lblSeat, seatParts.join(' · ')]);

    for (const [label, value] of detailRows) {
      doc.fontSize(7).font('Helvetica-Bold').fillColor(TEXT_MUTED).text(label, margin, y);
      doc.fontSize(detailFontSize).font('Helvetica').fillColor(TEXT_PRIMARY)
        .text(value, margin + 60, y, { width: leftWidth - 60 });
      y += detailLineHeight;
    }

    y += 4;
    doc.fontSize(9).font('Helvetica').fillColor(TEXT_SECONDARY)
      .text(`${TL.ticketOf} ${ticket.ticketNumber} / ${ticket.totalTickets}`, margin, y);

    const rightX = margin + leftWidth + 20;
    const rightWidth = contentWidth - leftWidth - 20;
    const dashY = margin + 14;
    const dashEnd = pageHeight - margin - 30;
    doc.save();
    doc.dash(4, { space: 3 });
    doc.moveTo(rightX - 10, dashY).lineTo(rightX - 10, dashEnd).strokeColor('#d0d0d0').lineWidth(0.5).stroke();
    doc.restore();
    doc.undash();

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
      doc.roundedRect(qrX - 8, qrY - 8, qrSize + 16, qrSize + 16, 8).fillColor('#ffffff').fill();
      doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
    } catch {
      doc.fontSize(8).fillColor(TEXT_MUTED).text(qrUrl, qrX, qrY, { width: qrSize });
    }

    const scanY = qrY + qrSize + 16;
    doc.fontSize(8).font('Helvetica').fillColor(TEXT_MUTED)
      .text(TL.scanVerify, rightX, scanY, { width: rightWidth, align: 'center' });

    const codeY = scanY + 20;
    const codeWidth = doc.widthOfString(ticket.ticketCode, { fontSize: 13 }) + 20;
    const codeX = rightX + (rightWidth - codeWidth) / 2;
    doc.roundedRect(codeX, codeY, codeWidth, 24, 6).fillColor(BRAND_PURPLE).opacity(0.1).fill();
    doc.opacity(1);
    doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_PURPLE)
      .text(ticket.ticketCode, codeX, codeY + 6, { width: codeWidth, align: 'center' });

    const footerY = pageHeight - margin - 6;
    if (!isWhiteLabel(opts.subscriptionTier)) {
      doc.fontSize(7).font('Helvetica').fillColor('#bbbbbb')
        .text(`${TL.footer}  ·  waaiio.com`, margin, footerY, { width: contentWidth, align: 'center' });
    }
  }

  doc.end();
  return bufferPromise;
}
