import PDFDocument from 'pdfkit';
import { formatCurrency, type CountryCode } from '@/lib/constants';

export interface InvoicePdfData {
  businessName: string;
  referenceCode: string;
  issueDate: string;
  dueDate: string | null;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  customerAddress: string | null;
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  discountType: string | null;
  discountValue: number;
  discountAmount: number;
  totalAmount: number;
  amountPaid: number;
  currency: string;
  notes: string | null;
  terms: string | null;
  status: string;
  countryCode: CountryCode;
}

function collectPdfBuffer(doc: PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function fmtCurrency(amount: number, countryCode: CountryCode): string {
  return formatCurrency(amount, countryCode);
}

export async function generateInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const margin = 50;
  const doc = new PDFDocument({ size: 'A4', margin });
  const bufferPromise = collectPdfBuffer(doc);

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - margin * 2;

  // ── Header ──
  doc.fontSize(24).font('Helvetica-Bold').fillColor('#333333')
    .text('INVOICE', margin, margin, { width: contentWidth, align: 'left' });

  doc.fontSize(11).font('Helvetica-Bold').fillColor('#555555')
    .text(data.businessName, margin, margin + 30);

  // Reference + dates on right
  const headerRightX = pageWidth - margin - 180;
  doc.fontSize(9).font('Helvetica').fillColor('#666666');
  doc.text(`Ref: ${data.referenceCode}`, headerRightX, margin, { width: 180, align: 'right' });
  doc.text(`Issue Date: ${formatDate(data.issueDate)}`, headerRightX, margin + 14, { width: 180, align: 'right' });
  doc.text(`Due Date: ${formatDate(data.dueDate)}`, headerRightX, margin + 28, { width: 180, align: 'right' });

  if (data.status === 'paid') {
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#16a34a')
      .text('PAID', headerRightX, margin + 46, { width: 180, align: 'right' });
  }

  // Divider
  let y = margin + 65;
  doc.moveTo(margin, y).lineTo(pageWidth - margin, y).strokeColor('#e5e5e5').stroke();

  // ── Bill To ──
  y += 15;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#999999')
    .text('BILL TO', margin, y);
  y += 14;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#333333')
    .text(data.customerName, margin, y);
  y += 15;

  doc.fontSize(9).font('Helvetica').fillColor('#555555');
  if (data.customerPhone) { doc.text(data.customerPhone, margin, y); y += 13; }
  if (data.customerEmail) { doc.text(data.customerEmail, margin, y); y += 13; }
  if (data.customerAddress) { doc.text(data.customerAddress, margin, y, { width: 300 }); y += 13; }

  y += 10;

  // ── Line Items Table ──
  const colX = {
    num: margin,
    desc: margin + 30,
    qty: margin + contentWidth - 210,
    price: margin + contentWidth - 140,
    amount: margin + contentWidth - 70,
  };
  const colW = {
    num: 25,
    desc: contentWidth - 250,
    qty: 65,
    price: 70,
    amount: 70,
  };

  // Table header
  doc.rect(margin, y, contentWidth, 20).fillColor('#f5f5f5').fill();
  doc.fillColor('#555555').fontSize(8).font('Helvetica-Bold');
  doc.text('#', colX.num + 4, y + 5, { width: colW.num });
  doc.text('Description', colX.desc, y + 5, { width: colW.desc });
  doc.text('Qty', colX.qty, y + 5, { width: colW.qty, align: 'right' });
  doc.text('Unit Price', colX.price, y + 5, { width: colW.price, align: 'right' });
  doc.text('Amount', colX.amount, y + 5, { width: colW.amount, align: 'right' });
  y += 22;

  // Table rows
  doc.fillColor('#333333').fontSize(9).font('Helvetica');

  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];

    // Page break check
    if (y + 20 > doc.page.height - 100) {
      doc.addPage();
      y = margin;
    }

    // Alternate row background
    if (i % 2 === 1) {
      doc.rect(margin, y - 2, contentWidth, 18).fillColor('#fafafa').fill();
      doc.fillColor('#333333');
    }

    doc.text(String(i + 1), colX.num + 4, y, { width: colW.num });
    doc.text(item.description.slice(0, 50), colX.desc, y, { width: colW.desc });
    doc.text(String(item.quantity), colX.qty, y, { width: colW.qty, align: 'right' });
    doc.text(fmtCurrency(item.unitPrice, data.countryCode), colX.price, y, { width: colW.price, align: 'right' });
    doc.text(fmtCurrency(item.amount, data.countryCode), colX.amount, y, { width: colW.amount, align: 'right' });
    y += 18;
  }

  // Divider
  y += 5;
  doc.moveTo(margin, y).lineTo(pageWidth - margin, y).strokeColor('#e5e5e5').stroke();
  y += 10;

  // ── Summary (right-aligned) ──
  const summaryLabelX = pageWidth - margin - 200;
  const summaryValueX = pageWidth - margin - 80;
  const summaryW = 80;

  function summaryRow(label: string, value: string, bold = false) {
    doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#555555');
    doc.text(label, summaryLabelX, y, { width: 115, align: 'right' });
    doc.fillColor(bold ? '#333333' : '#555555');
    doc.text(value, summaryValueX, y, { width: summaryW, align: 'right' });
    y += 16;
  }

  summaryRow('Subtotal', fmtCurrency(data.subtotal, data.countryCode));

  if (data.taxRate > 0) {
    summaryRow(`Tax (${data.taxRate}%)`, fmtCurrency(data.taxAmount, data.countryCode));
  }

  if (data.discountAmount > 0) {
    const discountLabel = data.discountType === 'percent'
      ? `Discount (${data.discountValue}%)`
      : 'Discount';
    summaryRow(discountLabel, `-${fmtCurrency(data.discountAmount, data.countryCode)}`);
  }

  summaryRow('Total', fmtCurrency(data.totalAmount, data.countryCode), true);

  if (data.amountPaid > 0) {
    summaryRow('Amount Paid', fmtCurrency(data.amountPaid, data.countryCode));
    const balance = data.totalAmount - data.amountPaid;
    summaryRow('Balance Due', fmtCurrency(balance, data.countryCode), true);
  }

  // ── Notes & Terms ──
  y += 10;

  if (data.notes) {
    if (y + 40 > doc.page.height - 60) { doc.addPage(); y = margin; }
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#555555')
      .text('Notes', margin, y);
    y += 14;
    doc.fontSize(9).font('Helvetica').fillColor('#666666')
      .text(data.notes, margin, y, { width: contentWidth - 100 });
    y += (doc as any).heightOfString(data.notes, { width: contentWidth - 100 }) + 10;
  }

  if (data.terms) {
    if (y + 40 > doc.page.height - 60) { doc.addPage(); y = margin; }
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#555555')
      .text('Terms & Conditions', margin, y);
    y += 14;
    doc.fontSize(8).font('Helvetica').fillColor('#888888')
      .text(data.terms, margin, y, { width: contentWidth - 100 });
    y += (doc as any).heightOfString(data.terms, { width: contentWidth - 100 }) + 10;
  }

  // ── Footer ──
  y += 20;
  if (y + 20 > doc.page.height - 40) { doc.addPage(); y = margin; }
  doc.fontSize(8).font('Helvetica').fillColor('#aaaaaa')
    .text('Powered by Waaiio', margin, y, { width: contentWidth, align: 'center' });

  doc.end();
  return bufferPromise;
}
