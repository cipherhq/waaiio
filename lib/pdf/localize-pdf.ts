/**
 * PDF Localization — Slice 5B (#524)
 *
 * Static/deterministic Waaiio-owned presentation chrome for non-legal PDFs.
 * No model/LLM call is made here and generated PDF buffers are never translated.
 * Runtime callers must resolve the effective response language through the existing
 * certification/entitlement authority before selecting a bundle.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type PdfStatusLabels = Record<string, string>;

export interface ReceiptPdfLabels {
  title: string;
  lblReference: string;
  lblService: string;
  lblCustomer: string;
  lblPhone: string;
  lblDate: string;
  lblPayment: string;
  lblSubtotal: string;
  lblFees: string;
  lblTotal: string;
  lblAmount: string;
  lblStatus: string;
  footer: string;
  statusLabels: PdfStatusLabels;
  monthShort: readonly string[];
}

export interface TicketPdfLabels {
  lblDate: string;
  lblTime: string;
  lblVenue: string;
  lblAttendee: string;
  lblRef: string;
  lblPrice: string;
  lblSeat: string;
  lblSection: string;
  lblRow: string;
  lblSeatNumber: string;
  scanVerify: string;
  ticketOf: string;
  footer: string;
}

export interface InvoicePdfLabels {
  title: string;
  lblPaid: string;
  lblBillTo: string;
  lblRef: string;
  lblIssueDate: string;
  lblDueDate: string;
  colDescription: string;
  colQty: string;
  colUnitPrice: string;
  colAmount: string;
  lblSubtotal: string;
  lblTax: string;
  lblDiscount: string;
  lblTotal: string;
  lblAmountPaid: string;
  lblBalanceDue: string;
  lblNotes: string;
  lblTerms: string;
  footer: string;
}

export interface HistoryPdfLabels {
  title: string;
  lblGenerated: string;
  colDate: string;
  colService: string;
  colBusiness: string;
  colRef: string;
  colAmount: string;
  colStatus: string;
  lblTotalTransactions: string;
  lblTotal: string;
  footer: string;
  statusLabels: PdfStatusLabels;
  monthShort: readonly string[];
}

export interface AnnualStatementPdfLabels {
  title: string;
  lblGenerated: string;
  colDate: string;
  colService: string;
  colBusiness: string;
  colRef: string;
  colAmount: string;
  colStatus: string;
  lblSubtotal: string;
  lblGrandTotal: string;
  lblTotalTransactions: string;
  taxDisclaimer: string;
  footer: string;
  statusLabels: PdfStatusLabels;
  monthNames: readonly string[];
  monthShort: readonly string[];
}

export interface PdfLocalizationBundle {
  receipt: ReceiptPdfLabels;
  ticket: TicketPdfLabels;
  invoice: InvoicePdfLabels;
  history: HistoryPdfLabels;
  annual: AnnualStatementPdfLabels;
}

const STATUS_EN: PdfStatusLabels = {
  paid: 'Paid', pending: 'Pending', completed: 'Completed', confirmed: 'Confirmed',
  delivered: 'Delivered', success: 'Successful', cancelled: 'Cancelled', failed: 'Failed', refunded: 'Refunded',
};
const STATUS_PCM: PdfStatusLabels = {
  paid: 'Don pay', pending: 'Dey wait', completed: 'Don complete', confirmed: 'Don confirm',
  delivered: 'Don deliver', success: 'Success', cancelled: 'Don cancel', failed: 'Fail', refunded: 'Refund don happen',
};
const STATUS_YO: PdfStatusLabels = {
  paid: 'Ti san', pending: 'Ń dúró', completed: 'Ti parí', confirmed: 'Ti jẹ́rìí',
  delivered: 'Ti fi dé', success: 'Aṣeyọrí', cancelled: 'Ti fagilé', failed: 'Kùnà', refunded: 'Ti dá owó padà',
};
const STATUS_IG: PdfStatusLabels = {
  paid: 'Akwụọla', pending: 'Na-echere', completed: 'Emechara', confirmed: 'Akwadoro',
  delivered: 'Ebutela', success: 'Ọ gara nke ọma', cancelled: 'Akagbuola', failed: 'Ọ dara ada', refunded: 'Eweghachila ego',
};
const STATUS_HA: PdfStatusLabels = {
  paid: 'An biya', pending: 'Ana jira', completed: 'An kammala', confirmed: 'An tabbatar',
  delivered: 'An kai', success: 'Nasara', cancelled: 'An soke', failed: 'Ya gaza', refunded: 'An mayar da kuɗi',
};
const STATUS_TW: PdfStatusLabels = {
  paid: 'Wɔatua', pending: 'Ɛretwɛn', completed: 'Awie', confirmed: 'Wɔahyɛ no den',
  delivered: 'Wɔde akɔ', success: 'Nkonim', cancelled: 'Wɔatwa mu', failed: 'Antumi', refunded: 'Wɔasan atua sika',
};
const STATUS_FR: PdfStatusLabels = {
  paid: 'Payé', pending: 'En attente', completed: 'Terminé', confirmed: 'Confirmé',
  delivered: 'Livré', success: 'Réussi', cancelled: 'Annulé', failed: 'Échoué', refunded: 'Remboursé',
};
const STATUS_ES: PdfStatusLabels = {
  paid: 'Pagado', pending: 'Pendiente', completed: 'Completado', confirmed: 'Confirmado',
  delivered: 'Entregado', success: 'Correcto', cancelled: 'Cancelado', failed: 'Fallido', refunded: 'Reembolsado',
};

const MONTH_SHORT_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const MONTHS_PCM = ['Month 1', 'Month 2', 'Month 3', 'Month 4', 'Month 5', 'Month 6', 'Month 7', 'Month 8', 'Month 9', 'Month 10', 'Month 11', 'Month 12'] as const;
const MONTHS_YO = ['Oṣù 1', 'Oṣù 2', 'Oṣù 3', 'Oṣù 4', 'Oṣù 5', 'Oṣù 6', 'Oṣù 7', 'Oṣù 8', 'Oṣù 9', 'Oṣù 10', 'Oṣù 11', 'Oṣù 12'] as const;
const MONTHS_IG = ['Ọnwa 1', 'Ọnwa 2', 'Ọnwa 3', 'Ọnwa 4', 'Ọnwa 5', 'Ọnwa 6', 'Ọnwa 7', 'Ọnwa 8', 'Ọnwa 9', 'Ọnwa 10', 'Ọnwa 11', 'Ọnwa 12'] as const;
const MONTHS_HA = ['Wata 1', 'Wata 2', 'Wata 3', 'Wata 4', 'Wata 5', 'Wata 6', 'Wata 7', 'Wata 8', 'Wata 9', 'Wata 10', 'Wata 11', 'Wata 12'] as const;
const MONTHS_TW = ['Bosome 1', 'Bosome 2', 'Bosome 3', 'Bosome 4', 'Bosome 5', 'Bosome 6', 'Bosome 7', 'Bosome 8', 'Bosome 9', 'Bosome 10', 'Bosome 11', 'Bosome 12'] as const;
const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'] as const;
const MONTH_SHORT_FR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'] as const;
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'] as const;
const MONTH_SHORT_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;

function simpleMonths(months: readonly string[]): readonly string[] { return months; }

export const DEFAULT_RECEIPT_LABELS: ReceiptPdfLabels = {
  title: 'RECEIPT', lblReference: 'Reference', lblService: 'Service', lblCustomer: 'Customer', lblPhone: 'Phone',
  lblDate: 'Date', lblPayment: 'Payment', lblSubtotal: 'Subtotal', lblFees: 'Fees', lblTotal: 'Total',
  lblAmount: 'Amount', lblStatus: 'Status', footer: 'Powered by Waaiio', statusLabels: STATUS_EN, monthShort: MONTH_SHORT_EN,
};
export const DEFAULT_TICKET_LABELS: TicketPdfLabels = {
  lblDate: 'DATE', lblTime: 'TIME', lblVenue: 'VENUE', lblAttendee: 'ATTENDEE', lblRef: 'REF', lblPrice: 'PRICE',
  lblSeat: 'SEAT', lblSection: 'Section', lblRow: 'Row', lblSeatNumber: 'Seat', scanVerify: 'Scan to verify',
  ticketOf: 'Ticket', footer: 'Powered by Waaiio',
};
export const DEFAULT_INVOICE_LABELS: InvoicePdfLabels = {
  title: 'INVOICE', lblPaid: 'PAID', lblBillTo: 'BILL TO', lblRef: 'Ref', lblIssueDate: 'Issue Date', lblDueDate: 'Due Date',
  colDescription: 'Description', colQty: 'Qty', colUnitPrice: 'Unit Price', colAmount: 'Amount', lblSubtotal: 'Subtotal',
  lblTax: 'Tax', lblDiscount: 'Discount', lblTotal: 'Total', lblAmountPaid: 'Amount Paid', lblBalanceDue: 'Balance Due',
  lblNotes: 'Notes', lblTerms: 'Terms & Conditions', footer: 'Powered by Waaiio',
};
export const DEFAULT_HISTORY_LABELS: HistoryPdfLabels = {
  title: 'TRANSACTION HISTORY', lblGenerated: 'Generated:', colDate: 'Date', colService: 'Service', colBusiness: 'Business',
  colRef: 'Ref', colAmount: 'Amount', colStatus: 'Status', lblTotalTransactions: 'Total Transactions:', lblTotal: 'Total:',
  footer: 'Powered by Waaiio', statusLabels: STATUS_EN, monthShort: MONTH_SHORT_EN,
};
export const DEFAULT_ANNUAL_LABELS: AnnualStatementPdfLabels = {
  title: 'ANNUAL STATEMENT', lblGenerated: 'Generated:', colDate: 'Date', colService: 'Service', colBusiness: 'Business',
  colRef: 'Ref', colAmount: 'Amount', colStatus: 'Status', lblSubtotal: 'Subtotal:', lblGrandTotal: 'Grand Total:',
  lblTotalTransactions: 'Total Transactions:',
  taxDisclaimer: 'This statement is provided for your records. Please consult your tax advisor regarding the deductibility of any amounts shown.',
  footer: 'Powered by Waaiio', statusLabels: STATUS_EN, monthNames: MONTHS_EN, monthShort: MONTH_SHORT_EN,
};

function makeBundle(
  statusLabels: PdfStatusLabels,
  monthNames: readonly string[],
  monthShort: readonly string[],
  receipt: Omit<ReceiptPdfLabels, 'statusLabels' | 'monthShort'>,
  ticket: TicketPdfLabels,
  invoice: InvoicePdfLabels,
  history: Omit<HistoryPdfLabels, 'statusLabels' | 'monthShort'>,
  annual: Omit<AnnualStatementPdfLabels, 'statusLabels' | 'monthNames' | 'monthShort'>,
): PdfLocalizationBundle {
  return {
    receipt: { ...receipt, statusLabels, monthShort }, ticket, invoice,
    history: { ...history, statusLabels, monthShort },
    annual: { ...annual, statusLabels, monthNames, monthShort },
  };
}

const BUNDLES: Record<string, PdfLocalizationBundle> = {
  en: { receipt: DEFAULT_RECEIPT_LABELS, ticket: DEFAULT_TICKET_LABELS, invoice: DEFAULT_INVOICE_LABELS, history: DEFAULT_HISTORY_LABELS, annual: DEFAULT_ANNUAL_LABELS },
  pcm: makeBundle(STATUS_PCM, MONTHS_PCM, simpleMonths(MONTHS_PCM),
    { ...DEFAULT_RECEIPT_LABELS, title: 'RECEIPT', lblReference: 'Reference', lblService: 'Service', lblCustomer: 'Customer', lblPhone: 'Phone', lblDate: 'Date', lblPayment: 'Payment', lblSubtotal: 'Subtotal', lblFees: 'Charges', lblTotal: 'Total', lblAmount: 'Amount', lblStatus: 'Status', footer: 'Waaiio power am' },
    { ...DEFAULT_TICKET_LABELS, lblDate: 'DATE', lblTime: 'TIME', lblVenue: 'PLACE', lblAttendee: 'PERSON', lblPrice: 'PRICE', lblSection: 'Section', lblRow: 'Row', lblSeatNumber: 'Seat', scanVerify: 'Scan am to verify', ticketOf: 'Ticket', footer: 'Waaiio power am' },
    { ...DEFAULT_INVOICE_LABELS, title: 'INVOICE', lblPaid: 'DON PAY', lblBillTo: 'BILL GO', lblIssueDate: 'Date wey dem issue am', lblDueDate: 'Due date', colDescription: 'Description', colQty: 'Qty', colUnitPrice: 'Price per one', colAmount: 'Amount', lblSubtotal: 'Subtotal', lblTax: 'Tax', lblDiscount: 'Discount', lblTotal: 'Total', lblAmountPaid: 'Amount paid', lblBalanceDue: 'Balance wey remain', lblNotes: 'Notes', lblTerms: 'Terms & Conditions', footer: 'Waaiio power am' },
    { ...DEFAULT_HISTORY_LABELS, title: 'TRANSACTION HISTORY', lblGenerated: 'Generated:', colDate: 'Date', colService: 'Service', colBusiness: 'Business', colAmount: 'Amount', colStatus: 'Status', lblTotalTransactions: 'Total transactions:', lblTotal: 'Total:', footer: 'Waaiio power am' },
    { ...DEFAULT_ANNUAL_LABELS, title: 'ANNUAL STATEMENT', lblGenerated: 'Generated:', colDate: 'Date', colService: 'Service', colBusiness: 'Business', colAmount: 'Amount', colStatus: 'Status', lblSubtotal: 'Subtotal:', lblGrandTotal: 'Grand total:', lblTotalTransactions: 'Total transactions:', taxDisclaimer: 'This statement na for your records. Abeg check with your tax adviser about any tax deduction.', footer: 'Waaiio power am' }),
  yo: makeBundle(STATUS_YO, MONTHS_YO, simpleMonths(MONTHS_YO),
    { ...DEFAULT_RECEIPT_LABELS, title: 'ÌGBÀWỌLÉ', lblReference: 'Ìtọ́kasí', lblService: 'Iṣẹ́', lblCustomer: 'Oníbàárà', lblPhone: 'Fóònù', lblDate: 'Ọjọ́', lblPayment: 'Ìsanwó', lblSubtotal: 'Àpapọ̀ kékeré', lblFees: 'Owó iṣẹ́', lblTotal: 'Àpapọ̀', lblAmount: 'Iye', lblStatus: 'Ipò', footer: 'Waaiio ló ń ṣiṣẹ́' },
    { ...DEFAULT_TICKET_LABELS, lblDate: 'ỌJỌ́', lblTime: 'ÀKÓKÒ', lblVenue: 'IBÙDÓ', lblAttendee: 'ALEJO', lblPrice: 'IYE', lblSeat: 'ÌJÓKÒÓ', lblSection: 'Abala', lblRow: 'Ìlà', lblSeatNumber: 'Ìjókòó', scanVerify: 'Ṣàyẹ̀wò láti jẹ́rìí', ticketOf: 'Tikẹ́ẹ̀tì', footer: 'Waaiio ló ń ṣiṣẹ́' },
    { ...DEFAULT_INVOICE_LABELS, title: 'INVOICE', lblPaid: 'TI SAN', lblBillTo: 'FI OWÓ RÁNṢẸ́ SÍ', lblIssueDate: 'Ọjọ́ ìfúnni', lblDueDate: 'Ọjọ́ ìsanwó', colDescription: 'Àpèjúwe', colQty: 'Iye', colUnitPrice: 'Iye ẹyọ', colAmount: 'Iye owó', lblSubtotal: 'Àpapọ̀ kékeré', lblTax: 'Owó-orí', lblDiscount: 'Ẹ̀dinwó', lblTotal: 'Àpapọ̀', lblAmountPaid: 'Owó tí a san', lblBalanceDue: 'Owó tó kù', lblNotes: 'Àkíyèsí', lblTerms: 'Àwọn òfin àti ipo', footer: 'Waaiio ló ń ṣiṣẹ́' },
    { ...DEFAULT_HISTORY_LABELS, title: 'ÌTÀN ÌDÚNÀDÚRÀ', lblGenerated: 'Ti dá sílẹ̀:', colDate: 'Ọjọ́', colService: 'Iṣẹ́', colBusiness: 'Iṣòwò', colAmount: 'Iye owó', colStatus: 'Ipò', lblTotalTransactions: 'Àpapọ̀ ìdúnàdúrà:', lblTotal: 'Àpapọ̀:', footer: 'Waaiio ló ń ṣiṣẹ́' },
    { ...DEFAULT_ANNUAL_LABELS, title: 'ÀLÀYÉ ỌDỌỌDÚN', lblGenerated: 'Ti dá sílẹ̀:', colDate: 'Ọjọ́', colService: 'Iṣẹ́', colBusiness: 'Iṣòwò', colAmount: 'Iye owó', colStatus: 'Ipò', lblSubtotal: 'Àpapọ̀ kékeré:', lblGrandTotal: 'Àpapọ̀ gbogbo:', lblTotalTransactions: 'Àpapọ̀ ìdúnàdúrà:', taxDisclaimer: 'Àlàyé yìí jẹ́ fún àkọsílẹ̀ rẹ. Jọ̀wọ́ bá olùdámọ̀ràn owó-orí rẹ sọ̀rọ̀ nípa ohun tí a lè yọ kúrò nínú owó-orí.', footer: 'Waaiio ló ń ṣiṣẹ́' }),
  ig: makeBundle(STATUS_IG, MONTHS_IG, simpleMonths(MONTHS_IG),
    { ...DEFAULT_RECEIPT_LABELS, title: 'NATA', lblReference: 'Ntụaka', lblService: 'Ọrụ', lblCustomer: 'Onye ahịa', lblPhone: 'Ekwentị', lblDate: 'Ụbọchị', lblPayment: 'Ịkwụ ụgwọ', lblSubtotal: 'Mkpokọta nta', lblFees: 'Ụgwọ', lblTotal: 'Mkpokọta', lblAmount: 'Ọnụ ego', lblStatus: 'Ọnọdụ', footer: 'Waaiio kwadoro ya' },
    { ...DEFAULT_TICKET_LABELS, lblDate: 'ỤBỌCHỊ', lblTime: 'OGE', lblVenue: 'EBE', lblAttendee: 'ONYE ỌBỊA', lblPrice: 'ỌNỤ EGO', lblSeat: 'OCHE', lblSection: 'Ngalaba', lblRow: 'Ahịrị', lblSeatNumber: 'Oche', scanVerify: 'Nyochaa iji kwado', ticketOf: 'Tiketi', footer: 'Waaiio kwadoro ya' },
    { ...DEFAULT_INVOICE_LABELS, title: 'INVOICE', lblPaid: 'AKWỤỌLA', lblBillTo: 'KWỤỌRỌ', lblIssueDate: 'Ụbọchị ewepụtara', lblDueDate: 'Ụbọchị ịkwụ ụgwọ', colDescription: 'Nkọwa', colQty: 'Ọnụọgụ', colUnitPrice: 'Ọnụ otu', colAmount: 'Ọnụ ego', lblSubtotal: 'Mkpokọta nta', lblTax: 'Ụtụ', lblDiscount: 'Mbelata', lblTotal: 'Mkpokọta', lblAmountPaid: 'Ego akwụrụ', lblBalanceDue: 'Ego fọdụrụ', lblNotes: 'Ndetu', lblTerms: 'Usoro na ọnọdụ', footer: 'Waaiio kwadoro ya' },
    { ...DEFAULT_HISTORY_LABELS, title: 'AKỤKỌ AZỤMAHỊA', lblGenerated: 'Emepụtara:', colDate: 'Ụbọchị', colService: 'Ọrụ', colBusiness: 'Azụmahịa', colAmount: 'Ọnụ ego', colStatus: 'Ọnọdụ', lblTotalTransactions: 'Mkpokọta azụmahịa:', lblTotal: 'Mkpokọta:', footer: 'Waaiio kwadoro ya' },
    { ...DEFAULT_ANNUAL_LABELS, title: 'NKWUPỤTA KWA AFỌ', lblGenerated: 'Emepụtara:', colDate: 'Ụbọchị', colService: 'Ọrụ', colBusiness: 'Azụmahịa', colAmount: 'Ọnụ ego', colStatus: 'Ọnọdụ', lblSubtotal: 'Mkpokọta nta:', lblGrandTotal: 'Mkpokọta niile:', lblTotalTransactions: 'Mkpokọta azụmahịa:', taxDisclaimer: 'Nkwupụta a bụ maka ndekọ gị. Biko gwa onye ndụmọdụ ụtụ isi gị gbasara ego ọ bụla a ga-ewepụ.', footer: 'Waaiio kwadoro ya' }),
  ha: makeBundle(STATUS_HA, MONTHS_HA, simpleMonths(MONTHS_HA),
    { ...DEFAULT_RECEIPT_LABELS, title: 'RASIT', lblReference: 'Manuniya', lblService: 'Sabis', lblCustomer: 'Abokin ciniki', lblPhone: 'Waya', lblDate: 'Kwanan wata', lblPayment: 'Biya', lblSubtotal: 'Jimla na farko', lblFees: 'Kuɗaɗe', lblTotal: 'Jimla', lblAmount: 'Adadi', lblStatus: 'Matsayi', footer: 'Waaiio ne ke sarrafa shi' },
    { ...DEFAULT_TICKET_LABELS, lblDate: 'KWANAN WATA', lblTime: 'LOKACI', lblVenue: 'WURI', lblAttendee: 'MAHALARTA', lblPrice: 'FARASHI', lblSeat: 'KUJERA', lblSection: 'Sashe', lblRow: 'Layi', lblSeatNumber: 'Kujera', scanVerify: 'Duba don tabbatarwa', ticketOf: 'Tikiti', footer: 'Waaiio ne ke sarrafa shi' },
    { ...DEFAULT_INVOICE_LABELS, title: 'INVOICE', lblPaid: 'AN BIYA', lblBillTo: 'A BIYA WA', lblIssueDate: 'Ranar fitarwa', lblDueDate: 'Ranar ƙarshe', colDescription: 'Bayani', colQty: 'Yawa', colUnitPrice: 'Farashin guda', colAmount: 'Adadi', lblSubtotal: 'Jimla na farko', lblTax: 'Haraji', lblDiscount: 'Rangwame', lblTotal: 'Jimla', lblAmountPaid: 'Adadin da aka biya', lblBalanceDue: 'Ragowar kuɗi', lblNotes: 'Bayanan kula', lblTerms: 'Sharuɗɗa da ƙa’idoji', footer: 'Waaiio ne ke sarrafa shi' },
    { ...DEFAULT_HISTORY_LABELS, title: 'TARIHIN MA’AMALA', lblGenerated: 'An ƙirƙira:', colDate: 'Kwanan wata', colService: 'Sabis', colBusiness: 'Kasuwanci', colAmount: 'Adadi', colStatus: 'Matsayi', lblTotalTransactions: 'Jimlar ma’amaloli:', lblTotal: 'Jimla:', footer: 'Waaiio ne ke sarrafa shi' },
    { ...DEFAULT_ANNUAL_LABELS, title: 'BAYANIN SHEKARA', lblGenerated: 'An ƙirƙira:', colDate: 'Kwanan wata', colService: 'Sabis', colBusiness: 'Kasuwanci', colAmount: 'Adadi', colStatus: 'Matsayi', lblSubtotal: 'Jimla na farko:', lblGrandTotal: 'Babban jimla:', lblTotalTransactions: 'Jimlar ma’amaloli:', taxDisclaimer: 'An bayar da wannan bayani don bayananka. Da fatan za ka tuntubi mai ba ka shawarar haraji game da duk wani cire haraji.', footer: 'Waaiio ne ke sarrafa shi' }),
  tw: makeBundle(STATUS_TW, MONTHS_TW, simpleMonths(MONTHS_TW),
    { ...DEFAULT_RECEIPT_LABELS, title: 'RECEIPT', lblReference: 'Nhwɛso', lblService: 'Ɔsom', lblCustomer: 'Ɔdwadifo', lblPhone: 'Tɛlɛfon', lblDate: 'Da', lblPayment: 'Tua', lblSubtotal: 'Nkabom ketewa', lblFees: 'Akatua', lblTotal: 'Nkabom', lblAmount: 'Sika dodow', lblStatus: 'Tebea', footer: 'Waaiio na ɛma ɛyɛ adwuma' },
    { ...DEFAULT_TICKET_LABELS, lblDate: 'DA', lblTime: 'BERƐ', lblVenue: 'BEA', lblAttendee: 'ƆBAA', lblPrice: 'BOƆ', lblSeat: 'AKONNWA', lblSection: 'Faako', lblRow: 'Ntoatoaso', lblSeatNumber: 'Akonnwa', scanVerify: 'Scan na hwɛ mu', ticketOf: 'Tikiti', footer: 'Waaiio na ɛma ɛyɛ adwuma' },
    { ...DEFAULT_INVOICE_LABELS, title: 'INVOICE', lblPaid: 'WƆATUA', lblBillTo: 'TUA MA', lblIssueDate: 'Da a wɔde mae', lblDueDate: 'Da a ɛsɛ sɛ wotua', colDescription: 'Nkyerɛkyerɛmu', colQty: 'Dodow', colUnitPrice: 'Baako boɔ', colAmount: 'Sika dodow', lblSubtotal: 'Nkabom ketewa', lblTax: 'Tow', lblDiscount: 'Ntewmu', lblTotal: 'Nkabom', lblAmountPaid: 'Sika a wɔatua', lblBalanceDue: 'Sika a aka', lblNotes: 'Nhyɛnsode', lblTerms: 'Mmara ne nhyehyɛe', footer: 'Waaiio na ɛma ɛyɛ adwuma' },
    { ...DEFAULT_HISTORY_LABELS, title: 'ADWUMADI ABALƆN', lblGenerated: 'Wɔyɛe:', colDate: 'Da', colService: 'Ɔsom', colBusiness: 'Adwuma', colAmount: 'Sika dodow', colStatus: 'Tebea', lblTotalTransactions: 'Adwumadi nyinaa:', lblTotal: 'Nkabom:', footer: 'Waaiio na ɛma ɛyɛ adwuma' },
    { ...DEFAULT_ANNUAL_LABELS, title: 'AFE BIARA NKYERƐKYERƐMU', lblGenerated: 'Wɔyɛe:', colDate: 'Da', colService: 'Ɔsom', colBusiness: 'Adwuma', colAmount: 'Sika dodow', colStatus: 'Tebea', lblSubtotal: 'Nkabom ketewa:', lblGrandTotal: 'Nkabom nyinaa:', lblTotalTransactions: 'Adwumadi nyinaa:', taxDisclaimer: 'Wɔde saa nkyerɛkyerɛmu yi ama wo sɛ wo kyerɛwtohɔ. Yɛsrɛ wo, bisa wo tow ho afotufoɔ wɔ sika a wobetumi ayi afi tow mu ho.', footer: 'Waaiio na ɛma ɛyɛ adwuma' }),
  fr: makeBundle(STATUS_FR, MONTHS_FR, MONTH_SHORT_FR,
    { ...DEFAULT_RECEIPT_LABELS, title: 'REÇU', lblReference: 'Référence', lblService: 'Service', lblCustomer: 'Client', lblPhone: 'Téléphone', lblDate: 'Date', lblPayment: 'Paiement', lblSubtotal: 'Sous-total', lblFees: 'Frais', lblTotal: 'Total', lblAmount: 'Montant', lblStatus: 'Statut', footer: 'Propulsé par Waaiio' },
    { ...DEFAULT_TICKET_LABELS, lblDate: 'DATE', lblTime: 'HEURE', lblVenue: 'LIEU', lblAttendee: 'PARTICIPANT', lblRef: 'RÉF', lblPrice: 'PRIX', lblSeat: 'SIÈGE', lblSection: 'Section', lblRow: 'Rangée', lblSeatNumber: 'Siège', scanVerify: 'Scanner pour vérifier', ticketOf: 'Billet', footer: 'Propulsé par Waaiio' },
    { ...DEFAULT_INVOICE_LABELS, title: 'FACTURE', lblPaid: 'PAYÉ', lblBillTo: 'FACTURER À', lblRef: 'Réf', lblIssueDate: 'Date d’émission', lblDueDate: 'Date d’échéance', colDescription: 'Description', colQty: 'Qté', colUnitPrice: 'Prix unitaire', colAmount: 'Montant', lblSubtotal: 'Sous-total', lblTax: 'Taxe', lblDiscount: 'Remise', lblTotal: 'Total', lblAmountPaid: 'Montant payé', lblBalanceDue: 'Solde dû', lblNotes: 'Notes', lblTerms: 'Conditions générales', footer: 'Propulsé par Waaiio' },
    { ...DEFAULT_HISTORY_LABELS, title: 'HISTORIQUE DES TRANSACTIONS', lblGenerated: 'Généré :', colDate: 'Date', colService: 'Service', colBusiness: 'Entreprise', colRef: 'Réf', colAmount: 'Montant', colStatus: 'Statut', lblTotalTransactions: 'Total des transactions :', lblTotal: 'Total :', footer: 'Propulsé par Waaiio' },
    { ...DEFAULT_ANNUAL_LABELS, title: 'RELEVÉ ANNUEL', lblGenerated: 'Généré :', colDate: 'Date', colService: 'Service', colBusiness: 'Entreprise', colRef: 'Réf', colAmount: 'Montant', colStatus: 'Statut', lblSubtotal: 'Sous-total :', lblGrandTotal: 'Total général :', lblTotalTransactions: 'Total des transactions :', taxDisclaimer: 'Ce relevé est fourni pour vos dossiers. Veuillez consulter votre conseiller fiscal concernant la déductibilité des montants indiqués.', footer: 'Propulsé par Waaiio' }),
  es: makeBundle(STATUS_ES, MONTHS_ES, MONTH_SHORT_ES,
    { ...DEFAULT_RECEIPT_LABELS, title: 'RECIBO', lblReference: 'Referencia', lblService: 'Servicio', lblCustomer: 'Cliente', lblPhone: 'Teléfono', lblDate: 'Fecha', lblPayment: 'Pago', lblSubtotal: 'Subtotal', lblFees: 'Cargos', lblTotal: 'Total', lblAmount: 'Importe', lblStatus: 'Estado', footer: 'Con tecnología de Waaiio' },
    { ...DEFAULT_TICKET_LABELS, lblDate: 'FECHA', lblTime: 'HORA', lblVenue: 'LUGAR', lblAttendee: 'ASISTENTE', lblRef: 'REF', lblPrice: 'PRECIO', lblSeat: 'ASIENTO', lblSection: 'Sección', lblRow: 'Fila', lblSeatNumber: 'Asiento', scanVerify: 'Escanea para verificar', ticketOf: 'Entrada', footer: 'Con tecnología de Waaiio' },
    { ...DEFAULT_INVOICE_LABELS, title: 'FACTURA', lblPaid: 'PAGADO', lblBillTo: 'FACTURAR A', lblRef: 'Ref', lblIssueDate: 'Fecha de emisión', lblDueDate: 'Fecha de vencimiento', colDescription: 'Descripción', colQty: 'Cant.', colUnitPrice: 'Precio unitario', colAmount: 'Importe', lblSubtotal: 'Subtotal', lblTax: 'Impuesto', lblDiscount: 'Descuento', lblTotal: 'Total', lblAmountPaid: 'Importe pagado', lblBalanceDue: 'Saldo pendiente', lblNotes: 'Notas', lblTerms: 'Términos y condiciones', footer: 'Con tecnología de Waaiio' },
    { ...DEFAULT_HISTORY_LABELS, title: 'HISTORIAL DE TRANSACCIONES', lblGenerated: 'Generado:', colDate: 'Fecha', colService: 'Servicio', colBusiness: 'Negocio', colRef: 'Ref', colAmount: 'Importe', colStatus: 'Estado', lblTotalTransactions: 'Total de transacciones:', lblTotal: 'Total:', footer: 'Con tecnología de Waaiio' },
    { ...DEFAULT_ANNUAL_LABELS, title: 'ESTADO ANUAL', lblGenerated: 'Generado:', colDate: 'Fecha', colService: 'Servicio', colBusiness: 'Negocio', colRef: 'Ref', colAmount: 'Importe', colStatus: 'Estado', lblSubtotal: 'Subtotal:', lblGrandTotal: 'Total general:', lblTotalTransactions: 'Total de transacciones:', taxDisclaimer: 'Este estado se proporciona para sus registros. Consulte a su asesor fiscal sobre la deducibilidad de los importes mostrados.', footer: 'Con tecnología de Waaiio' }),
};

/** Deterministic bundle selection only. Caller authority determines the language. */
export function getPdfLocalizationBundle(language: string | null | undefined): PdfLocalizationBundle {
  return (language && BUNDLES[language]) || BUNDLES.en;
}

/**
 * Production-owned seam: resolve customer language → select deterministic PDF bundle.
 * Returns undefined for English or on any failure (fail-closed to English defaults).
 *
 * Callers: send-tickets.ts (ticket), post-completion.ts (receipt), invoices/send/route.ts (invoice)
 */
export async function resolvePdfLabels<K extends keyof PdfLocalizationBundle>(
  supabase: SupabaseClient,
  customerPhone: string,
  businessId: string,
  docType: K,
  resolver: 'proactive' | 'email',
): Promise<PdfLocalizationBundle[K] | undefined> {
  try {
    let language: string;
    if (resolver === 'proactive') {
      const { resolveProactiveLocalization } = await import('@/lib/payments/proactive-localization');
      const l10n = await resolveProactiveLocalization(supabase, customerPhone, businessId);
      language = l10n.language;
    } else {
      const { resolveEmailLocalization } = await import('@/lib/email/localize-email');
      const l10n = await resolveEmailLocalization(supabase, customerPhone, businessId);
      language = l10n.language;
    }
    if (language !== 'en') return getPdfLocalizationBundle(language)[docType];
  } catch { /* fail closed to English */ }
  return undefined;
}
