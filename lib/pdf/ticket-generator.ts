import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { isWhiteLabel } from '@/lib/whitelabel';
import { formatCurrency, formatCurrencyCode, type CountryCode } from '@/lib/constants';
import { encodeCode128B } from './code128';
import { WAAIIO_WORDMARK_PNG, WAAIIO_WORDMARK_ASPECT } from './brand-assets';
import { fetchImageBuffer, loadBusinessLogo, toPdfImage } from './merchant-image';

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
  /** Organiser name, printed on the ticket and the stub. */
  businessName?: string;
  /** businesses.logo_url. Drawn only when it is a file in the business-documents bucket. */
  businessLogoUrl?: string;
  /** Slice 5B: deterministic Waaiio-owned labels selected by authorized language. */
  labels?: import('./localize-pdf').TicketPdfLabels;
}

// Owner decision 2026-11-04: Waaiio purple for every ticket, white text and line art.
const BRAND_PURPLE = '#6C2BD9';
const BRAND_DARK = '#240D55';
const PAGE_BG = '#EFEBF7';
const STUB_BG = '#FFFFFF';
const STUB_TEXT = '#3B3350';
const STUB_MUTED = '#8A8399';

// Landscape ticket (~2.75:1) with a tear-off stub on the left, like a printed event ticket.
const PAGE_W = 780;
const PAGE_H = 300;
const CARD_X = 12;
const CARD_Y = 12;
const CARD_W = PAGE_W - CARD_X * 2;
const CARD_H = PAGE_H - CARD_Y * 2;
const CARD_RADIUS = 12;
const STUB_W = 136;
const PERF_X = CARD_X + STUB_W;
const QR_BOX = 96;
const QR_SIZE = 82;

function collectPdfBuffer(doc: PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/** Embed an image once so every page reuses the same PDF object. */
function openPdfImage(doc: any, buf: Buffer | null): unknown | null {
  if (!buf) return null;
  try {
    return doc.openImage(buf);
  } catch {
    return null;
  }
}

/** Largest font size (≤ max) at which `text` fits in `maxLines` lines of `width`. */
function fitFontSize(doc: any, text: string, width: number, max: number, min: number, maxLines: number): number {
  for (let size = max; size > min; size -= 1) {
    doc.fontSize(size);
    const lines = Math.round(doc.heightOfString(text, { width }) / doc.currentLineHeight(true));
    if (lines <= maxLines) return size;
  }
  return min;
}

/** Draw text rotated 90° anticlockwise, centred on the vertical span [yTop, yBottom] at x. */
function verticalText(doc: any, text: string, x: number, yTop: number, yBottom: number) {
  const span = yBottom - yTop;
  doc.save();
  doc.rotate(-90, { origin: [x, yBottom] });
  doc.text(text, x, yBottom, { width: span, align: 'center', lineBreak: false, height: doc.currentLineHeight(true) });
  doc.restore();
}

function drawLineArt(doc: any, bodyX: number, bodyRight: number) {
  doc.save();
  doc.lineWidth(1.1).strokeColor('#FFFFFF').strokeOpacity(0.55);
  const top = CARD_Y;
  const bottom = CARD_Y + CARD_H;
  // Top-right flowing curve
  doc.moveTo(bodyRight - 250, top - 4)
    .bezierCurveTo(bodyRight - 230, top + 34, bodyRight - 160, top + 54, bodyRight - 120, top + 26)
    .bezierCurveTo(bodyRight - 80, top - 2, bodyRight - 40, top + 30, bodyRight - 52, top + 72)
    .bezierCurveTo(bodyRight - 62, top + 108, bodyRight - 14, top + 120, bodyRight + 4, top + 104)
    .stroke();
  // Bottom-left flowing curve: stays left of the text column and under the date/time/venue row
  doc.moveTo(bodyX - 4, bottom - 150)
    .bezierCurveTo(bodyX + 34, bottom - 128, bodyX + 4, bottom - 30, bodyX + 70, bottom - 14)
    .bezierCurveTo(bodyX + 140, bottom + 2, bodyX + 200, bottom - 20, bodyX + 260, bottom + 4)
    .stroke();
  doc.restore();
}

function drawBarcode(doc: any, code: string, barX: number, barLen: number, yTop: number, yBottom: number) {
  const modules = encodeCode128B(code);
  const QUIET = 10; // quiet zone in modules, top and bottom
  const total = modules.reduce((a, b) => a + b, 0) + QUIET * 2;
  const unit = Math.min(1.2, (yBottom - yTop) / total);
  let y = yTop + ((yBottom - yTop) - total * unit) / 2 + QUIET * unit;
  doc.save();
  doc.fillColor('#000000');
  modules.forEach((width, i) => {
    // Even indices are bars, odd are spaces. The code runs top to bottom (barcode rotated 90°).
    if (i % 2 === 0) doc.rect(barX, y, barLen, width * unit).fill();
    y += width * unit;
  });
  doc.restore();
}

export async function generateTicketsPdf(opts: TicketPdfOptions): Promise<Buffer> {
  const { DEFAULT_TICKET_LABELS: TICKET_DEFAULTS } = await import('./localize-pdf');
  const TL = opts.labels || TICKET_DEFAULTS;
  const whiteLabel = isWhiteLabel(opts.subscriptionTier);

  const doc: any = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: 0 });
  const bufferPromise = collectPdfBuffer(doc);

  let flyerImage: unknown = null;
  if (opts.flyerUrl) {
    const raw = await fetchImageBuffer(opts.flyerUrl);
    if (raw) flyerImage = openPdfImage(doc, await toPdfImage(raw, 1200, 'jpeg'));
  }

  const wordmarkImage = whiteLabel ? null : openPdfImage(doc, WAAIIO_WORDMARK_PNG);

  const logoImage = openPdfImage(doc, await loadBusinessLogo(opts.businessLogoUrl));

  const businessName = (opts.businessName || '').trim();
  let priceStr: string | null = null;
  if (opts.price !== undefined && opts.price > 0) {
    priceStr = opts.currencyCode
      ? formatCurrencyCode(opts.price, opts.currencyCode)
      : formatCurrency(opts.price, (opts.countryCode || 'NG') as CountryCode);
  }
  const seatParts: string[] = [];
  if (opts.section) seatParts.push(`${TL.lblSection} ${opts.section}`);
  if (opts.row) seatParts.push(`${TL.lblRow} ${opts.row}`);
  if (opts.seat) seatParts.push(`${TL.lblSeatNumber} ${opts.seat}`);

  const bodyX = PERF_X;
  const bodyRight = CARD_X + CARD_W;
  const contentX = bodyX + 30;
  const qrBoxX = bodyRight - 26 - QR_BOX;
  const contentW = qrBoxX - 24 - contentX;

  for (let i = 0; i < opts.tickets.length; i++) {
    const ticket = opts.tickets[i];
    if (i > 0) doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 });
    const ticketOf = `${TL.ticketOf} ${ticket.ticketNumber} / ${ticket.totalTickets}`;

    // ── Page and ticket card ──
    doc.rect(0, 0, PAGE_W, PAGE_H).fillColor(PAGE_BG).fill();
    doc.save();
    doc.roundedRect(CARD_X, CARD_Y + 3, CARD_W, CARD_H, CARD_RADIUS).fillColor(BRAND_DARK).fillOpacity(0.12).fill();
    doc.restore();

    doc.save();
    doc.roundedRect(CARD_X, CARD_Y, CARD_W, CARD_H, CARD_RADIUS).clip();
    doc.rect(CARD_X, CARD_Y, STUB_W, CARD_H).fillColor(STUB_BG).fill();
    doc.rect(bodyX, CARD_Y, bodyRight - bodyX, CARD_H).fillColor(BRAND_PURPLE).fill();
    if (flyerImage) {
      doc.save();
      try {
        doc.rect(bodyX, CARD_Y, bodyRight - bodyX, CARD_H).clip();
        doc.opacity(0.14);
        doc.image(flyerImage, bodyX, CARD_Y, { cover: [bodyRight - bodyX, CARD_H], align: 'center', valign: 'center' });
      } catch { /* continue without flyer */ } finally {
        doc.restore();
      }
    }
    drawLineArt(doc, bodyX, bodyRight);
    doc.restore();

    // ── Tear line: scalloped stub edge plus notches at top and bottom ──
    doc.save();
    doc.fillColor(STUB_BG);
    for (let y = CARD_Y + 16; y <= CARD_Y + CARD_H - 16; y += 9) doc.circle(PERF_X, y, 2.6).fill();
    doc.fillColor(PAGE_BG);
    doc.circle(PERF_X, CARD_Y, 9).fill();
    doc.circle(PERF_X, CARD_Y + CARD_H, 9).fill();
    doc.restore();

    // ── Stub ──
    const stubFooterTop = CARD_Y + CARD_H - 66;
    const barTop = CARD_Y + 14;
    const barBottom = stubFooterTop - 6;
    doc.font('Helvetica').fontSize(6).fillColor(STUB_MUTED);
    verticalText(doc, `${TL.lblRef} ${opts.referenceCode}   ·   ${ticketOf}`, CARD_X + 10, barTop, barBottom);
    drawBarcode(doc, ticket.ticketCode, CARD_X + 32, 50, barTop, barBottom);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(STUB_TEXT);
    verticalText(doc, ticket.ticketCode, CARD_X + 88, barTop, barBottom);

    if (wordmarkImage) {
      // Owner decision 2026-11-05: the stub carries the Waaiio logo; the business's own logo
      // (if uploaded) sits beside its name in the purple body.
      const wmH = 20;
      const wmW = wmH * WAAIIO_WORDMARK_ASPECT;
      doc.image(wordmarkImage, CARD_X + (STUB_W - wmW) / 2, stubFooterTop + 14, { width: wmW, height: wmH });
      doc.font('Helvetica').fontSize(6).fillColor(STUB_MUTED)
        .text(`${TL.footer} · waaiio.com`, CARD_X + 8, CARD_Y + CARD_H - 15, { width: STUB_W - 16, align: 'center', lineBreak: false });
    } else {
      // White-label: no Waaiio branding; the stub shows the business logo (or initial) and name.
      const markSize = 26;
      const markX = CARD_X + (STUB_W - markSize) / 2;
      const markY = stubFooterTop + 2;
      let markDrawn = false;
      if (logoImage) {
        try {
          doc.image(logoImage, markX, markY, { fit: [markSize, markSize], align: 'center', valign: 'center' });
          markDrawn = true;
        } catch { /* fall back to monogram */ }
      }
      if (!markDrawn && businessName) {
        doc.circle(markX + markSize / 2, markY + markSize / 2, markSize / 2).fillColor(BRAND_PURPLE).fill();
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF')
          .text((Array.from(businessName)[0] || '').toUpperCase(), markX, markY + 7, { width: markSize, align: 'center', lineBreak: false });
      }
      if (businessName) {
        doc.font('Helvetica-Bold').fontSize(7).fillColor(STUB_TEXT)
          .text(businessName, CARD_X + 8, markY + markSize + 4, { width: STUB_W - 16, align: 'center', height: 9, ellipsis: true });
      }
    }

    // ── Main body ──
    // Clip the text column: Helvetica can't measure some non-Latin text correctly, so a long
    // title must not spill under the QR or off the card.
    doc.save();
    doc.rect(contentX, CARD_Y, contentW, CARD_H).clip();
    let y = CARD_Y + 28;
    if (businessName) {
      // Business's own logo, small, before its name (only when not shown on a white-label stub).
      let nameX = contentX;
      if (logoImage && wordmarkImage) {
        try {
          doc.image(logoImage, contentX, y - 4, { fit: [18, 18], align: 'center', valign: 'center' });
          nameX += 24;
        } catch { /* name only */ }
      }
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#FFFFFF').fillOpacity(0.85)
        .text(businessName.toUpperCase(), nameX, y, { width: contentW - (nameX - contentX), characterSpacing: 1.5, height: 13, ellipsis: true });
      doc.fillOpacity(1);
      y += 18;
    }

    doc.font('Helvetica-Bold');
    const titleSize = fitFontSize(doc, opts.eventName, contentW, 36, 16, 2);
    doc.fontSize(titleSize);
    const titleLines = Math.round(doc.heightOfString(opts.eventName, { width: contentW }) / doc.currentLineHeight(true));
    const titleOneLineW = doc.widthOfString(opts.eventName);
    doc.fillColor('#FFFFFF').text(opts.eventName, contentX, y, {
      width: contentW, lineGap: -2, height: doc.currentLineHeight(true) * 2, ellipsis: true,
    });
    const titleBottom = y + Math.min(titleLines, 2) * (doc.currentLineHeight(true) - 2);

    // Ticket type sits beside a one-line title (like "TICKET  MOCKUP" in the sample), else below it.
    if (opts.ticketType) {
      const typeText = opts.ticketType.toUpperCase();
      const typeSize = Math.max(12, Math.round(titleSize * 0.5));
      doc.font('Helvetica').fontSize(typeSize);
      const typeW = doc.widthOfString(typeText);
      if (titleLines === 1 && titleOneLineW + 10 + typeW <= contentW) {
        doc.text(typeText, contentX + titleOneLineW + 10, y + titleSize - typeSize - 1, { lineBreak: false });
        y = titleBottom + 6;
      } else {
        y = titleBottom + 2;
        doc.text(typeText, contentX, y, { width: contentW, height: typeSize * 1.3, ellipsis: true });
        y += typeSize * 1.3 + 4;
      }
    } else {
      y = titleBottom + 6;
    }

    const infoParts = [`${TL.lblAttendee}  ${opts.guestName}`];
    if (priceStr) infoParts.push(`${TL.lblPrice}  ${priceStr}`);
    if (seatParts.length > 0) infoParts.push(`${TL.lblSeat}  ${seatParts.join(' · ')}`);
    doc.font('Helvetica').fontSize(9.5).fillColor('#FFFFFF').fillOpacity(0.92)
      .text(infoParts.join('   |   '), contentX, y, { width: contentW, height: 26, ellipsis: true });
    doc.fillOpacity(1);

    // Bottom row: date, time, venue as two-line pairs.
    const rowY = CARD_Y + CARD_H - 64;
    const cols: Array<[string, string, number]> = [[TL.lblDate, opts.eventDate, 118]];
    if (opts.eventTime) cols.push([TL.lblTime, opts.eventTime, 84]);
    const usedW = cols.reduce((a, c) => a + c[2] + 16, 0);
    if (opts.venue) cols.push([TL.lblVenue, opts.venue, Math.max(80, contentW - usedW)]);
    let colX = contentX;
    for (const [label, value, width] of cols) {
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#FFFFFF').fillOpacity(0.7)
        .text(label.toUpperCase(), colX, rowY, { width, characterSpacing: 1, lineBreak: false });
      doc.fillOpacity(1);
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF')
        .text(value, colX, rowY + 12, { width, height: 30, lineGap: -1, ellipsis: true });
      colX += width + 16;
    }
    doc.restore();

    // QR: same payload as before (verify URL), so phone-camera check-in is unchanged.
    const qrUrl = `${opts.verifyBaseUrl}/${ticket.ticketCode}`;
    const qrBoxY = CARD_Y + 30;
    doc.roundedRect(qrBoxX, qrBoxY, QR_BOX, QR_BOX, 10).fillColor('#FFFFFF').fill();
    try {
      const qrDataUrl = await QRCode.toDataURL(qrUrl, {
        width: QR_SIZE * 3,
        margin: 1,
        color: { dark: BRAND_DARK, light: '#ffffff' },
      });
      const qrBuffer = Buffer.from(qrDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
      const qrOffset = (QR_BOX - QR_SIZE) / 2;
      doc.image(qrBuffer, qrBoxX + qrOffset, qrBoxY + qrOffset, { width: QR_SIZE, height: QR_SIZE });
    } catch {
      doc.font('Helvetica').fontSize(6).fillColor(BRAND_DARK).text(qrUrl, qrBoxX + 6, qrBoxY + 6, { width: QR_BOX - 12 });
    }
    let qy = qrBoxY + QR_BOX + 8;
    doc.font('Helvetica').fontSize(7).fillColor('#FFFFFF').fillOpacity(0.85)
      .text(TL.scanVerify, qrBoxX - 10, qy, { width: QR_BOX + 20, align: 'center', lineBreak: false });
    doc.fillOpacity(1);
    qy += 12;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#FFFFFF')
      .text(ticket.ticketCode, qrBoxX - 10, qy, { width: QR_BOX + 20, align: 'center', lineBreak: false });
    qy += 14;
    doc.font('Helvetica').fontSize(8).fillColor('#FFFFFF').fillOpacity(0.85)
      .text(ticketOf, qrBoxX - 10, qy, { width: QR_BOX + 20, align: 'center', lineBreak: false });
    doc.fillOpacity(1);
  }

  doc.end();
  return bufferPromise;
}
