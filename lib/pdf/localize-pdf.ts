/**
 * PDF Localization — Slice 5B (#524)
 *
 * Provides translatable label sets for receipt, ticket, and invoice PDFs.
 * Labels are translated BEFORE PDF rendering — the PDF generator receives
 * pre-localized strings and renders them normally.
 *
 * NEVER post-processes a generated PDF buffer.
 */

/** Receipt PDF labels */
export interface ReceiptPdfLabels {
  title: string;         // "RECEIPT"
  lblReference: string;  // "Reference"
  lblService: string;    // "Service"
  lblCustomer: string;   // "Customer"
  lblPhone: string;      // "Phone"
  lblDate: string;       // "Date"
  lblPayment: string;    // "Payment"
  lblSubtotal: string;   // "Subtotal"
  lblFees: string;       // "Fees"
  lblTotal: string;      // "Total"
  lblAmount: string;     // "Amount"
  lblStatus: string;     // "Status"
  footer: string;        // "Powered by Waaiio"
}

/** Ticket PDF labels */
export interface TicketPdfLabels {
  lblDate: string;       // "DATE"
  lblTime: string;       // "TIME"
  lblVenue: string;      // "VENUE"
  lblAttendee: string;   // "ATTENDEE"
  lblRef: string;        // "REF"
  lblPrice: string;      // "PRICE"
  lblSeat: string;       // "SEAT"
  scanVerify: string;    // "Scan to verify"
  ticketOf: string;      // "Ticket X of Y"
  footer: string;        // "Powered by Waaiio"
}

/** Invoice PDF labels */
export interface InvoicePdfLabels {
  title: string;           // "INVOICE"
  lblPaid: string;         // "PAID"
  lblBillTo: string;       // "BILL TO"
  lblRef: string;          // "Ref"
  lblIssueDate: string;    // "Issue Date"
  lblDueDate: string;      // "Due Date"
  colDescription: string;  // "Description"
  colQty: string;          // "Qty"
  colUnitPrice: string;    // "Unit Price"
  colAmount: string;       // "Amount"
  lblSubtotal: string;     // "Subtotal"
  lblTax: string;          // "Tax"
  lblDiscount: string;     // "Discount"
  lblTotal: string;        // "Total"
  lblAmountPaid: string;   // "Amount Paid"
  lblBalanceDue: string;   // "Balance Due"
  lblNotes: string;        // "Notes"
  lblTerms: string;        // "Terms & Conditions"
  footer: string;          // "Powered by Waaiio"
}

export const DEFAULT_RECEIPT_LABELS: ReceiptPdfLabels = {
  title: 'RECEIPT', lblReference: 'Reference', lblService: 'Service',
  lblCustomer: 'Customer', lblPhone: 'Phone', lblDate: 'Date',
  lblPayment: 'Payment', lblSubtotal: 'Subtotal', lblFees: 'Fees',
  lblTotal: 'Total', lblAmount: 'Amount', lblStatus: 'Status',
  footer: 'Powered by Waaiio',
};

export const DEFAULT_TICKET_LABELS: TicketPdfLabels = {
  lblDate: 'DATE', lblTime: 'TIME', lblVenue: 'VENUE',
  lblAttendee: 'ATTENDEE', lblRef: 'REF', lblPrice: 'PRICE',
  lblSeat: 'SEAT', scanVerify: 'Scan to verify',
  ticketOf: 'Ticket', footer: 'Powered by Waaiio',
};

export const DEFAULT_INVOICE_LABELS: InvoicePdfLabels = {
  title: 'INVOICE', lblPaid: 'PAID', lblBillTo: 'BILL TO',
  lblRef: 'Ref', lblIssueDate: 'Issue Date', lblDueDate: 'Due Date',
  colDescription: 'Description', colQty: 'Qty', colUnitPrice: 'Unit Price',
  colAmount: 'Amount', lblSubtotal: 'Subtotal', lblTax: 'Tax',
  lblDiscount: 'Discount', lblTotal: 'Total',
  lblAmountPaid: 'Amount Paid', lblBalanceDue: 'Balance Due',
  lblNotes: 'Notes', lblTerms: 'Terms & Conditions',
  footer: 'Powered by Waaiio',
};
