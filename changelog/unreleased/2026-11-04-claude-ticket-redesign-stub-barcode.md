## 2026-11-04 — Event ticket PDF redesigned as a real ticket: tear-off stub, barcode and QR

**What changed** (Owner request with a sample image; Owner decisions 1A and 2A, 2026-11-04)

- The ticket PDF sent on WhatsApp after a ticket purchase now looks like a printed event ticket. It is one landscape page per ticket (780 × 300 pt):
  - a white tear-off **stub** on the left, holding:
    - a vertical **Code 128 barcode** of the ticket code, with the code printed beside it;
    - the booking reference and "Ticket n / total";
    - the organiser's logo (a lettered circle if there is none) and name;
    - "Powered by Waaiio" unless the tier is white-label;
  - a scalloped tear line with notches;
  - a **Waaiio-purple** body (decision 2A) with white text and white curved line art, holding:
    - the organiser name;
    - a large event title, with the ticket type beside or under it;
    - attendee, price and seat;
    - a bottom row of date, time and venue;
    - a small **QR code** on the right (decision 1A), with "Scan to verify", the ticket code and "Ticket n / total".
- The event flyer, when present, still shows as a faint background in the purple body.
- **Files:**
  - `lib/pdf/ticket-generator.ts` (layout);
  - `lib/pdf/code128.ts` (new, a small Code 128 set B encoder);
  - `lib/bot/flows/shared/send-tickets.ts`, which now also reads `businesses.name` and `logo_url` in its existing tier query and passes them to the PDF.

**Check-in is unchanged**

- The QR still holds exactly `<APP_URL>/tickets/<ticket_code>`, so phone-camera self-check-in and the public ticket page work as before.
- The dashboard scanners (`app/dashboard/events/scan` and `checkin`, html5-qrcode with default formats) also read Code 128. The barcode text is the raw ticket code, which the scanners already accept and send to `/api/tickets/verify/<code>`.
- The barcode runs vertically on the stub, as in the Owner's sample. html5-qrcode's own decoder reads 1-D codes only along horizontal lines (`TRY_HARDER` is off). So on browsers without a native barcode detector (iOS Safari, Firefox), staff must hold the ticket sideways to scan the barcode. Chrome on Android reads it either way.
- The QR reads in any orientation and is the main check-in code.
- Manual entry and WhatsApp `TK-` check-in are untouched.
- No database, API or scanner change.

**Logo and flyer handling** (reviewer claude-reviewer-891-b, P1-1, P2-3, P2-4)

- The logo is fetched only from the public `business-documents` bucket of this project's Supabase URL, where `/api/business/upload-logo` stores it. The URL is parsed first, so `..` and `%2e%2e` are resolved, and the origin and path must match. Redirects are refused. Any other `logo_url` is ignored, so a hand-edited value can't make the server fetch an arbitrary address.
- Logo and flyer downloads over 5 MB are ignored.
- Both images are re-encoded with Sharp:
  - logo: PNG, at most 256 px;
  - flyer: JPEG, at most 1200 px.
- This covers WebP, which uploads allow but PDFKit can't draw.
- Each image is embedded once and reused on every page. A 4096² transparent logo on 10 tickets used to take about 84 s and produce a 717 KB PDF (measured by the reviewer under heavy machine load). It now takes about 1 s and produces 60 KB, so the PDF can't delay ticket delivery inside the 60 s payment webhook.
- The text column is clipped, so a title Helvetica mis-measures (for example Yoruba diacritics) can't spill under the QR.
- The flyer's drawing state is always restored.

**Barcode vs QR** (reviewer claude-reviewer-891-b, P2-1)

- The Code 128 barcode is sized for printed tickets and for scanning at normal print or screen resolution. It decodes at 2× and 3× render scale, not at 1×.
- On a phone screen the QR, which decodes at 1×, is the check-in path. Both encode the same ticket code.
- No CI test decodes the barcode from the rendered PDF, because CI has no canvas package. Rendered-pixel decoding was done locally with the stub rotated upright (reviewers A and B reproduced it).

**Also fixed by the new layout:** the old design put its footer below the page's bottom margin, so PDFKit added a blank page after every ticket. The new layout has no margin overflow, and a test checks one page per ticket.

**Tests:**
- `lib/pdf/__tests__/ticket-stub-barcode.test.ts` (new). It:
  - decodes the barcode with the zxing build bundled in html5-qrcode, the dashboard scanner's own decoder;
  - extracts the PDF text with pdfjs-dist to check every detail and the page size and count;
  - checks the QR payload, logo fetch and conversion, the logo allow-list, white-label and localized labels.
- `lib/pdf/__tests__/delivery-wiring.test.ts` (new case) checks that the organiser name and logo come from the businesses row.

**Could break:**
- The ticket page is now wider and shorter, so anyone printing tickets gets a different page shape.
- The Waaiio wordmark image is no longer fetched for the PDF; the "Powered by Waaiio" text remains.
- Non-Latin characters (e.g. Yoruba diacritics) still use the built-in Helvetica, which can't draw them, the same as before. Fixing that needs an embedded Unicode font across all PDFs and is a separate follow-up.
- The WhatsApp ticket *image* (`app/api/tickets/image`) is a separate design and is not changed here.
