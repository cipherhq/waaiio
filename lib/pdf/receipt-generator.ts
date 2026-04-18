import PDFDocument from 'pdfkit';
import { formatCurrency, type CountryCode } from '@/lib/constants';

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

function collectPdfBuffer(doc: PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// ── Single Receipt PDF (A5-ish, clean layout) ──

export async function generateReceiptPdf(data: ReceiptData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A5', margin: 40 });
  const bufferPromise = collectPdfBuffer(doc);

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 80; // 40px margin each side

  // Header
  doc.fontSize(20).font('Helvetica-Bold')
    .text('RECEIPT', 40, 40, { width: contentWidth, align: 'center' });

  doc.fontSize(11).font('Helvetica')
    .text(data.businessName, 40, 65, { width: contentWidth, align: 'center' });

  // Divider
  doc.moveTo(40, 90).lineTo(pageWidth - 40, 90).strokeColor('#cccccc').stroke();

  // Details
  let y = 105;
  const labelX = 40;
  const valueX = 180;
  const lineHeight = 22;

  const rows: [string, string][] = [
    ['Reference', data.referenceCode],
    ['Date', formatDate(data.date)],
    ['Service', data.serviceName],
    ['Amount', formatCurrency(data.amount, data.countryCode)],
    ['Status', data.paymentStatus.charAt(0).toUpperCase() + data.paymentStatus.slice(1)],
    ['Customer', data.customerName],
    ['Phone', maskPhone(data.customerPhone)],
  ];

  for (const [label, value] of rows) {
    doc.fontSize(10).font('Helvetica-Bold').text(label, labelX, y);
    doc.fontSize(10).font('Helvetica').text(value, valueX, y, { width: contentWidth - (valueX - labelX) });
    y += lineHeight;
  }

  // Divider
  y += 10;
  doc.moveTo(40, y).lineTo(pageWidth - 40, y).strokeColor('#cccccc').stroke();

  // Footer
  if (!data.whitelabel) {
    y += 15;
    doc.fontSize(8).font('Helvetica').fillColor('#888888')
      .text('Powered by Waaiio', 40, y, { width: contentWidth, align: 'center' });
  }

  doc.end();
  return bufferPromise;
}

// ── Transaction History PDF (A4, table layout) ──

export async function generateHistoryPdf(data: HistoryData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const bufferPromise = collectPdfBuffer(doc);

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 80;
  const rows = data.rows.slice(0, 50); // cap at 50

  // Header
  doc.fontSize(18).font('Helvetica-Bold')
    .text('TRANSACTION HISTORY', 40, 40, { width: contentWidth, align: 'center' });

  doc.fontSize(10).font('Helvetica')
    .text(`${data.customerName}  |  ${maskPhone(data.customerPhone)}`, 40, 65, {
      width: contentWidth, align: 'center',
    });

  doc.fontSize(9).font('Helvetica').fillColor('#666666')
    .text(`Generated: ${formatDate(new Date().toISOString())}`, 40, 80, {
      width: contentWidth, align: 'center',
    });

  doc.fillColor('#000000');

  // Table header
  let y = 105;
  const cols = {
    date: { x: 40, w: 75 },
    service: { x: 115, w: 130 },
    business: { x: 245, w: 110 },
    ref: { x: 355, w: 75 },
    amount: { x: 430, w: 70 },
    status: { x: 500, w: 55 },
  };

  // Table header background
  doc.rect(40, y - 3, contentWidth, 18).fillColor('#f0f0f0').fill();
  doc.fillColor('#333333');

  doc.fontSize(8).font('Helvetica-Bold');
  doc.text('Date', cols.date.x, y, { width: cols.date.w });
  doc.text('Service', cols.service.x, y, { width: cols.service.w });
  doc.text('Business', cols.business.x, y, { width: cols.business.w });
  doc.text('Ref', cols.ref.x, y, { width: cols.ref.w });
  doc.text('Amount', cols.amount.x, y, { width: cols.amount.w, align: 'right' });
  doc.text('Status', cols.status.x, y, { width: cols.status.w });

  y += 20;
  doc.fillColor('#000000');

  // Table rows
  const rowHeight = 18;
  let totalAmount = 0;

  for (const row of rows) {
    // Check if we need a new page
    if (y + rowHeight > doc.page.height - 60) {
      doc.addPage();
      y = 40;
    }

    // Alternate row background
    if (rows.indexOf(row) % 2 === 1) {
      doc.rect(40, y - 3, contentWidth, rowHeight).fillColor('#fafafa').fill();
      doc.fillColor('#000000');
    }

    doc.fontSize(8).font('Helvetica');
    doc.text(formatDate(row.date), cols.date.x, y, { width: cols.date.w });
    doc.text(row.serviceName.slice(0, 25), cols.service.x, y, { width: cols.service.w });
    doc.text(row.businessName.slice(0, 20), cols.business.x, y, { width: cols.business.w });
    doc.text(row.referenceCode || '-', cols.ref.x, y, { width: cols.ref.w });
    doc.text(formatCurrency(row.amount, data.countryCode), cols.amount.x, y, { width: cols.amount.w, align: 'right' });
    doc.text(row.status, cols.status.x, y, { width: cols.status.w });

    totalAmount += row.amount;
    y += rowHeight;
  }

  // Summary
  y += 10;
  if (y + 40 > doc.page.height - 40) {
    doc.addPage();
    y = 40;
  }

  doc.moveTo(40, y).lineTo(pageWidth - 40, y).strokeColor('#cccccc').stroke();
  y += 10;

  doc.fontSize(10).font('Helvetica-Bold')
    .text(`Total Transactions: ${rows.length}`, 40, y);
  doc.text(`Total Amount: ${formatCurrency(totalAmount, data.countryCode)}`, 300, y, {
    width: contentWidth - 260, align: 'right',
  });

  // Footer
  if (!data.whitelabel) {
    y += 30;
    doc.fontSize(8).font('Helvetica').fillColor('#888888')
      .text('Powered by Waaiio', 40, y, { width: contentWidth, align: 'center' });
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
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const bufferPromise = collectPdfBuffer(doc);

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 80;

  // Header
  doc.fontSize(18).font('Helvetica-Bold')
    .text(`ANNUAL STATEMENT — ${data.year}`, 40, 40, { width: contentWidth, align: 'center' });

  if (data.businessName) {
    doc.fontSize(11).font('Helvetica')
      .text(data.businessName, 40, 65, { width: contentWidth, align: 'center' });
  }

  const subHeaderY = data.businessName ? 82 : 65;
  doc.fontSize(10).font('Helvetica')
    .text(`${data.customerName}  |  ${maskPhone(data.customerPhone)}`, 40, subHeaderY, {
      width: contentWidth, align: 'center',
    });

  doc.fontSize(9).font('Helvetica').fillColor('#666666')
    .text(`Generated: ${formatDate(new Date().toISOString())}`, 40, subHeaderY + 15, {
      width: contentWidth, align: 'center',
    });

  doc.fillColor('#000000');

  // Group rows by month
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const grouped = new Map<number, HistoryRow[]>();
  for (const row of data.rows) {
    const d = new Date(row.date);
    const month = d.getMonth();
    if (!grouped.has(month)) grouped.set(month, []);
    grouped.get(month)!.push(row);
  }

  // Sort months ascending
  const sortedMonths = Array.from(grouped.keys()).sort((a, b) => a - b);

  // Table columns
  const cols = {
    date: { x: 40, w: 75 },
    service: { x: 115, w: 140 },
    business: { x: 255, w: 110 },
    ref: { x: 365, w: 70 },
    amount: { x: 435, w: 70 },
    status: { x: 505, w: 50 },
  };

  let y = subHeaderY + 35;
  let grandTotal = 0;
  const rowHeight = 18;

  for (const monthIdx of sortedMonths) {
    const monthRows = grouped.get(monthIdx)!;

    // Check page space for month header + at least 1 row
    if (y + 40 > doc.page.height - 60) {
      doc.addPage();
      y = 40;
    }

    // Month header
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#333333')
      .text(`${monthNames[monthIdx]} ${data.year}`, 40, y);
    y += 20;

    // Table header
    doc.rect(40, y - 3, contentWidth, 18).fillColor('#f0f0f0').fill();
    doc.fillColor('#333333');
    doc.fontSize(8).font('Helvetica-Bold');
    doc.text('Date', cols.date.x, y, { width: cols.date.w });
    doc.text('Service', cols.service.x, y, { width: cols.service.w });
    doc.text('Business', cols.business.x, y, { width: cols.business.w });
    doc.text('Ref', cols.ref.x, y, { width: cols.ref.w });
    doc.text('Amount', cols.amount.x, y, { width: cols.amount.w, align: 'right' });
    doc.text('Status', cols.status.x, y, { width: cols.status.w });
    y += 20;
    doc.fillColor('#000000');

    let monthTotal = 0;

    for (let i = 0; i < monthRows.length; i++) {
      const row = monthRows[i];

      if (y + rowHeight > doc.page.height - 60) {
        doc.addPage();
        y = 40;
      }

      if (i % 2 === 1) {
        doc.rect(40, y - 3, contentWidth, rowHeight).fillColor('#fafafa').fill();
        doc.fillColor('#000000');
      }

      doc.fontSize(8).font('Helvetica');
      doc.text(formatDate(row.date), cols.date.x, y, { width: cols.date.w });
      doc.text(row.serviceName.slice(0, 28), cols.service.x, y, { width: cols.service.w });
      doc.text(row.businessName.slice(0, 20), cols.business.x, y, { width: cols.business.w });
      doc.text(row.referenceCode || '-', cols.ref.x, y, { width: cols.ref.w });
      doc.text(formatCurrency(row.amount, data.countryCode), cols.amount.x, y, { width: cols.amount.w, align: 'right' });
      doc.text(row.status, cols.status.x, y, { width: cols.status.w });

      monthTotal += row.amount;
      y += rowHeight;
    }

    // Month subtotal
    y += 4;
    doc.fontSize(9).font('Helvetica-Bold')
      .text(`Subtotal: ${formatCurrency(monthTotal, data.countryCode)}`, 40, y, {
        width: contentWidth, align: 'right',
      });
    y += 20;
    grandTotal += monthTotal;
  }

  // Grand total
  if (y + 60 > doc.page.height - 40) {
    doc.addPage();
    y = 40;
  }

  doc.moveTo(40, y).lineTo(pageWidth - 40, y).strokeColor('#cccccc').stroke();
  y += 12;

  doc.fontSize(11).font('Helvetica-Bold')
    .text(`Total Transactions: ${data.rows.length}`, 40, y);
  doc.text(`Grand Total: ${formatCurrency(grandTotal, data.countryCode)}`, 300, y, {
    width: contentWidth - 260, align: 'right',
  });

  // Tax notice
  y += 25;
  doc.fontSize(8).font('Helvetica').fillColor('#666666')
    .text(
      'This statement is provided for your records. Please consult your tax advisor regarding the deductibility of any amounts shown.',
      40, y, { width: contentWidth, align: 'center' },
    );

  // Footer
  if (!data.whitelabel) {
    y += 25;
    doc.fontSize(8).font('Helvetica').fillColor('#888888')
      .text('Powered by Waaiio', 40, y, { width: contentWidth, align: 'center' });
  }

  doc.end();
  return bufferPromise;
}
