import PDFDocument from 'pdfkit';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { formatTicketCurrency } from './currency';

// ── Types ──

export interface ReceiptData {
  businessName: string;
  referenceCode: string;
  date: string;          // ISO date or formatted string
  serviceName: string;
  amount: number;
  paymentStatus: string; // e.g. "paid", "pending", "completed"
  customerName: string;
  customerPhone: string; // will be masked
  countryCode: CountryCode;
  whitelabel?: boolean;
  logoUrl?: string;      // business logo URL — rendered at top of receipt
  // Optional fee breakdown
  subtotal?: number;
  fees?: number;
  paymentMethod?: string; // e.g. "Card ****4242", "Bank Transfer"
}

export interface HistoryRow {
  date: string;
  serviceName: string;
  businessName: string;
  referenceCode: string;
  amount: number;
  status: string;
}

export interface HistoryData {
  customerName: string;
  customerPhone: string;
  countryCode: CountryCode;
  rows: HistoryRow[];
  whitelabel?: boolean;
}

// ── Brand colors ──
const BRAND_PURPLE = '#6C2BD9';
const BRAND_PURPLE_LIGHT = '#9F67FF';
const TEXT_PRIMARY = '#1a1a1a';
const TEXT_SECONDARY = '#555555';
const TEXT_MUTED = '#888888';
const DIVIDER = '#e5e5e5';
const BG_LIGHT = '#faf8ff';

// ── Helpers ──

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 6) return '***' + digits.slice(-3);
  return digits.slice(0, 3) + '****' + digits.slice(-3);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'paid' || s === 'completed' || s === 'confirmed' || s === 'delivered' || s === 'success') return '#22c55e';
  if (s === 'pending') return '#f59e0b';
  if (s === 'cancelled' || s === 'failed' || s === 'refunded') return '#ef4444';
  return BRAND_PURPLE;
}

function collectPdfBuffer(doc: PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// ── Single Receipt PDF (A5, Waaiio-branded) ──

export async function generateReceiptPdf(data: ReceiptData): Promise<Buffer> {
  // Cast to any — PDFKit's TS types don't expose roundedRect/opacity/etc.
  const doc: any = new PDFDocument({ size: 'A5', margin: 40 });
  const bufferPromise = collectPdfBuffer(doc);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const contentWidth = pageWidth - 80;
  const margin = 40;

  // ── Subtle background ──
  doc.rect(0, 0, pageWidth, pageHeight).fillColor(BG_LIGHT).fill();

  // ── Top accent bar ──
  doc.rect(0, 0, pageWidth, 5).fillColor(BRAND_PURPLE).fill();
  doc.rect(pageWidth * 0.6, 0, pageWidth * 0.4, 5).fillColor(BRAND_PURPLE_LIGHT).fill();

  // ── Logo / Business name header ──
  let headerY = margin + 8;
  if (data.logoUrl) {
    try {
      const logoRes = await fetch(data.logoUrl, { signal: AbortSignal.timeout(5000) });
      if (logoRes.ok) {
        const logoBuffer = Buffer.from(await logoRes.arrayBuffer());
        const logoSize = 44;
        const logoX = (pageWidth - logoSize) / 2;
        doc.image(logoBuffer, logoX, headerY, { width: logoSize, height: logoSize, fit: [logoSize, logoSize] });
        headerY += logoSize + 6;
      }
    } catch { /* skip */ }
  }

  // "RECEIPT" header
  doc.fontSize(18).font('Helvetica-Bold').fillColor(TEXT_PRIMARY)
    .text('RECEIPT', margin, headerY, { width: contentWidth, align: 'center' });
  headerY += 22;

  // Business name
  doc.fontSize(11).font('Helvetica').fillColor(TEXT_SECONDARY)
    .text(data.businessName, margin, headerY, { width: contentWidth, align: 'center' });
  headerY += 18;

  // Status badge
  const sColor = statusColor(data.paymentStatus);
  const statusLabel = data.paymentStatus.charAt(0).toUpperCase() + data.paymentStatus.slice(1);
  const statusWidth = doc.widthOfString(statusLabel, { fontSize: 9 }) + 20;
  const statusX = (pageWidth - statusWidth) / 2;
  doc.roundedRect(statusX, headerY, statusWidth, 18, 9).fillColor(sColor).opacity(0.1).fill();
  doc.opacity(1);
  doc.fontSize(9).font('Helvetica-Bold').fillColor(sColor)
    .text(statusLabel, statusX, headerY + 4, { width: statusWidth, align: 'center' });
  headerY += 28;

  // ── Divider ──
  doc.moveTo(margin, headerY).lineTo(pageWidth - margin, headerY).strokeColor(DIVIDER).lineWidth(0.5).stroke();

  // ── Detail rows ──
  let y = headerY + 14;
  const labelX = margin;
  const valueX = margin + 100;
  const lineHeight = 22;

  const detailRows: [string, string][] = [
    ['Reference', data.referenceCode],
    ['Date', formatDate(data.date)],
    ['Service', data.serviceName],
    ['Customer', data.customerName],
    ['Phone', maskPhone(data.customerPhone)],
  ];
  if (data.paymentMethod) {
    detailRows.push(['Payment', data.paymentMethod]);
  }

  for (const [label, value] of detailRows) {
    doc.fontSize(8).font('Helvetica-Bold').fillColor(TEXT_MUTED).text(label.toUpperCase(), labelX, y);
    doc.fontSize(10).font('Helvetica').fillColor(TEXT_PRIMARY).text(value, valueX, y, { width: contentWidth - (valueX - labelX) });
    y += lineHeight;
  }

  // ── Amount section ──
  y += 6;
  doc.moveTo(margin, y).lineTo(pageWidth - margin, y).strokeColor(DIVIDER).lineWidth(0.5).stroke();
  y += 12;

  // Subtotal/fees if available
  if (data.subtotal !== undefined) {
    doc.fontSize(10).font('Helvetica').fillColor(TEXT_SECONDARY).text('Subtotal', labelX, y);
    doc.text(formatTicketCurrency(data.subtotal, data.countryCode), valueX + 60, y, { width: 100, align: 'right' });
    y += lineHeight;
  }
  if (data.fees !== undefined && data.fees > 0) {
    doc.fontSize(10).font('Helvetica').fillColor(TEXT_SECONDARY).text('Fees', labelX, y);
    doc.text(formatTicketCurrency(data.fees, data.countryCode), valueX + 60, y, { width: 100, align: 'right' });
    y += lineHeight;
  }

  // Total amount (prominent)
  if (data.subtotal !== undefined || (data.fees !== undefined && data.fees > 0)) {
    doc.moveTo(margin + 80, y - 4).lineTo(pageWidth - margin, y - 4).strokeColor(DIVIDER).lineWidth(0.5).stroke();
    y += 4;
  }
  doc.fontSize(12).font('Helvetica-Bold').fillColor(TEXT_PRIMARY).text('Total', labelX, y);
  doc.fontSize(14).font('Helvetica-Bold').fillColor(BRAND_PURPLE)
    .text(formatCurrency(data.amount, data.countryCode), valueX + 40, y - 2, { width: 120, align: 'right' });

  // ── Footer ──
  if (!data.whitelabel) {
    const footerY = pageHeight - margin - 10;
    doc.moveTo(margin, footerY - 12).lineTo(pageWidth - margin, footerY - 12).strokeColor(DIVIDER).lineWidth(0.5).stroke();
    doc.fontSize(7).font('Helvetica').fillColor('#bbbbbb')
      .text('Powered by Waaiio  ·  waaiio.com', margin, footerY, { width: contentWidth, align: 'center' });
  }

  doc.end();
  return bufferPromise;
}

// ── Transaction History PDF (A4, table layout) ──

export async function generateHistoryPdf(data: HistoryData): Promise<Buffer> {
  const doc: any = new PDFDocument({ size: 'A4', margin: 40 });
  const bufferPromise = collectPdfBuffer(doc);

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 80;
  const rows = data.rows.slice(0, 50);

  // Background
  doc.rect(0, 0, pageWidth, doc.page.height).fillColor('#fefefe').fill();

  // Top accent
  doc.rect(0, 0, pageWidth, 4).fillColor(BRAND_PURPLE).fill();

  // Header
  doc.fontSize(18).font('Helvetica-Bold').fillColor(TEXT_PRIMARY)
    .text('TRANSACTION HISTORY', 40, 44, { width: contentWidth, align: 'center' });

  doc.fontSize(10).font('Helvetica').fillColor(TEXT_SECONDARY)
    .text(`${data.customerName}  ·  ${maskPhone(data.customerPhone)}`, 40, 68, {
      width: contentWidth, align: 'center',
    });

  doc.fontSize(9).font('Helvetica').fillColor(TEXT_MUTED)
    .text(`Generated: ${formatDate(new Date().toISOString())}`, 40, 83, {
      width: contentWidth, align: 'center',
    });

  // Table header
  let y = 108;
  const cols = {
    date: { x: 40, w: 75 },
    service: { x: 115, w: 130 },
    business: { x: 245, w: 110 },
    ref: { x: 355, w: 75 },
    amount: { x: 430, w: 70 },
    status: { x: 500, w: 55 },
  };

  doc.rect(40, y - 3, contentWidth, 18).fillColor(BRAND_PURPLE).opacity(0.06).fill();
  doc.opacity(1).fillColor(TEXT_SECONDARY);

  doc.fontSize(8).font('Helvetica-Bold');
  doc.text('Date', cols.date.x, y, { width: cols.date.w });
  doc.text('Service', cols.service.x, y, { width: cols.service.w });
  doc.text('Business', cols.business.x, y, { width: cols.business.w });
  doc.text('Ref', cols.ref.x, y, { width: cols.ref.w });
  doc.text('Amount', cols.amount.x, y, { width: cols.amount.w, align: 'right' });
  doc.text('Status', cols.status.x, y, { width: cols.status.w });

  y += 20;

  // Rows
  const rowHeight = 18;
  let totalAmount = 0;

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    if (y + rowHeight > doc.page.height - 60) {
      doc.addPage();
      y = 40;
    }

    if (idx % 2 === 1) {
      doc.rect(40, y - 3, contentWidth, rowHeight).fillColor('#faf8ff').fill();
    }

    doc.fillColor(TEXT_PRIMARY).fontSize(8).font('Helvetica');
    doc.text(formatDate(row.date), cols.date.x, y, { width: cols.date.w });
    doc.text(row.serviceName.slice(0, 25), cols.service.x, y, { width: cols.service.w });
    doc.text(row.businessName.slice(0, 20), cols.business.x, y, { width: cols.business.w });
    doc.text(row.referenceCode || '-', cols.ref.x, y, { width: cols.ref.w });
    doc.text(formatCurrency(row.amount, data.countryCode), cols.amount.x, y, { width: cols.amount.w, align: 'right' });

    // Color-coded status
    doc.fillColor(statusColor(row.status));
    doc.text(row.status, cols.status.x, y, { width: cols.status.w });

    totalAmount += row.amount;
    y += rowHeight;
  }

  // Summary
  y += 10;
  if (y + 40 > doc.page.height - 40) { doc.addPage(); y = 40; }

  doc.moveTo(40, y).lineTo(pageWidth - 40, y).strokeColor(DIVIDER).lineWidth(0.5).stroke();
  y += 10;

  doc.fillColor(TEXT_PRIMARY).fontSize(10).font('Helvetica-Bold')
    .text(`Total Transactions: ${rows.length}`, 40, y);
  doc.fillColor(BRAND_PURPLE)
    .text(`Total: ${formatCurrency(totalAmount, data.countryCode)}`, 300, y, {
      width: contentWidth - 260, align: 'right',
    });

  // Footer
  if (!data.whitelabel) {
    y += 30;
    doc.fontSize(7).font('Helvetica').fillColor('#bbbbbb')
      .text('Powered by Waaiio  ·  waaiio.com', 40, y, { width: contentWidth, align: 'center' });
  }

  doc.end();
  return bufferPromise;
}

// ── Annual Statement PDF (A4, grouped by month) ──

export interface AnnualStatementData {
  customerName: string;
  customerPhone: string;
  countryCode: CountryCode;
  year: number;
  businessName?: string;
  rows: HistoryRow[];
  whitelabel?: boolean;
}

export async function generateAnnualStatementPdf(data: AnnualStatementData): Promise<Buffer> {
  const doc: any = new PDFDocument({ size: 'A4', margin: 40 });
  const bufferPromise = collectPdfBuffer(doc);

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 80;

  // Background + accent
  doc.rect(0, 0, pageWidth, doc.page.height).fillColor('#fefefe').fill();
  doc.rect(0, 0, pageWidth, 4).fillColor(BRAND_PURPLE).fill();

  // Header
  doc.fontSize(18).font('Helvetica-Bold').fillColor(TEXT_PRIMARY)
    .text(`ANNUAL STATEMENT — ${data.year}`, 40, 44, { width: contentWidth, align: 'center' });

  if (data.businessName) {
    doc.fontSize(11).font('Helvetica').fillColor(TEXT_SECONDARY)
      .text(data.businessName, 40, 68, { width: contentWidth, align: 'center' });
  }

  const subHeaderY = data.businessName ? 85 : 68;
  doc.fontSize(10).font('Helvetica').fillColor(TEXT_SECONDARY)
    .text(`${data.customerName}  ·  ${maskPhone(data.customerPhone)}`, 40, subHeaderY, {
      width: contentWidth, align: 'center',
    });

  doc.fontSize(9).font('Helvetica').fillColor(TEXT_MUTED)
    .text(`Generated: ${formatDate(new Date().toISOString())}`, 40, subHeaderY + 15, {
      width: contentWidth, align: 'center',
    });

  // Group by month
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const grouped = new Map<number, HistoryRow[]>();
  for (const row of data.rows) {
    const d = new Date(row.date);
    const month = d.getMonth();
    if (!grouped.has(month)) grouped.set(month, []);
    grouped.get(month)!.push(row);
  }

  const sortedMonths = Array.from(grouped.keys()).sort((a, b) => a - b);

  const cols = {
    date: { x: 40, w: 75 },
    service: { x: 115, w: 140 },
    business: { x: 255, w: 110 },
    ref: { x: 365, w: 70 },
    amount: { x: 435, w: 70 },
    status: { x: 505, w: 50 },
  };

  let y = subHeaderY + 38;
  let grandTotal = 0;
  const rowHeight = 18;

  for (const monthIdx of sortedMonths) {
    const monthRows = grouped.get(monthIdx)!;

    if (y + 40 > doc.page.height - 60) { doc.addPage(); y = 40; }

    // Month header
    doc.fontSize(12).font('Helvetica-Bold').fillColor(BRAND_PURPLE)
      .text(`${monthNames[monthIdx]} ${data.year}`, 40, y);
    y += 20;

    // Table header
    doc.rect(40, y - 3, contentWidth, 18).fillColor(BRAND_PURPLE).opacity(0.06).fill();
    doc.opacity(1).fillColor(TEXT_SECONDARY);
    doc.fontSize(8).font('Helvetica-Bold');
    doc.text('Date', cols.date.x, y, { width: cols.date.w });
    doc.text('Service', cols.service.x, y, { width: cols.service.w });
    doc.text('Business', cols.business.x, y, { width: cols.business.w });
    doc.text('Ref', cols.ref.x, y, { width: cols.ref.w });
    doc.text('Amount', cols.amount.x, y, { width: cols.amount.w, align: 'right' });
    doc.text('Status', cols.status.x, y, { width: cols.status.w });
    y += 20;

    let monthTotal = 0;

    for (let i = 0; i < monthRows.length; i++) {
      const row = monthRows[i];
      if (y + rowHeight > doc.page.height - 60) { doc.addPage(); y = 40; }

      if (i % 2 === 1) {
        doc.rect(40, y - 3, contentWidth, rowHeight).fillColor('#faf8ff').fill();
      }

      doc.fillColor(TEXT_PRIMARY).fontSize(8).font('Helvetica');
      doc.text(formatDate(row.date), cols.date.x, y, { width: cols.date.w });
      doc.text(row.serviceName.slice(0, 28), cols.service.x, y, { width: cols.service.w });
      doc.text(row.businessName.slice(0, 20), cols.business.x, y, { width: cols.business.w });
      doc.text(row.referenceCode || '-', cols.ref.x, y, { width: cols.ref.w });
      doc.text(formatCurrency(row.amount, data.countryCode), cols.amount.x, y, { width: cols.amount.w, align: 'right' });
      doc.fillColor(statusColor(row.status));
      doc.text(row.status, cols.status.x, y, { width: cols.status.w });

      monthTotal += row.amount;
      y += rowHeight;
    }

    y += 4;
    doc.fillColor(TEXT_PRIMARY).fontSize(9).font('Helvetica-Bold')
      .text(`Subtotal: ${formatCurrency(monthTotal, data.countryCode)}`, 40, y, {
        width: contentWidth, align: 'right',
      });
    y += 20;
    grandTotal += monthTotal;
  }

  // Grand total
  if (y + 60 > doc.page.height - 40) { doc.addPage(); y = 40; }

  doc.moveTo(40, y).lineTo(pageWidth - 40, y).strokeColor(DIVIDER).lineWidth(0.5).stroke();
  y += 12;

  doc.fillColor(TEXT_PRIMARY).fontSize(11).font('Helvetica-Bold')
    .text(`Total Transactions: ${data.rows.length}`, 40, y);
  doc.fillColor(BRAND_PURPLE)
    .text(`Grand Total: ${formatCurrency(grandTotal, data.countryCode)}`, 300, y, {
      width: contentWidth - 260, align: 'right',
    });

  // Tax notice
  y += 25;
  doc.fontSize(8).font('Helvetica').fillColor(TEXT_MUTED)
    .text(
      'This statement is provided for your records. Please consult your tax advisor regarding the deductibility of any amounts shown.',
      40, y, { width: contentWidth, align: 'center' },
    );

  // Footer
  if (!data.whitelabel) {
    y += 25;
    doc.fontSize(7).font('Helvetica').fillColor('#bbbbbb')
      .text('Powered by Waaiio  ·  waaiio.com', 40, y, { width: contentWidth, align: 'center' });
  }

  doc.end();
  return bufferPromise;
}
