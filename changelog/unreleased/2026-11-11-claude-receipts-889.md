## 2026-11-11 — Receipts list what was bought, show deposits and the buyer's name, and broken receipt paths work again (#889)

**Why:** the #889 audit found that receipts never listed the items bought, often printed "Customer" instead of the buyer's name, and that three paths were broken.

**The Owner decided on 2026-11-11 (option B with i):**
- receipts list what was bought;
- a deposit shows the total, the amount paid and the balance due;
- the buyer's own name is used;
- the seller shown is the business name only.

Re-checked at `c26cb3f7`, on staging and production:
- `invoices.description`, `orders.delivery_name`, `order_items.product_name` and `campaigns.name` do not exist, but the code still selected them.
- Bug B (orders without receipts) was already fixed: all 8 paid card orders on staging since 2026-11-02 have a receipt.
- Bug D (WebP logos) was fixed in #901.

**What changed**
- **`lib/pdf/receipt-generator.ts`:**
  - **Item table:** an optional `items` list adds a table with Description, Qty, Unit price and Amount. It shows up to 6 rows; any more are summed up as "+N …".
  - **Deposits:** the optional `totalDue` and `balanceDue` print Total, Amount paid and Balance due, but only when the balance is above 0.
  - **Long receipts:** if the content would run into the footer, the totals move to a second page.
  - **Unchanged:** without these fields, the receipt prints exactly as before.
- **`lib/pdf/localize-pdf.ts`:** the new receipt labels reuse each language's existing invoice wording (`makeBundle`), so there are no new translations.
- **`lib/receipts/line-items.ts`** (new, read-only):
  - order lines: product name plus variant, quantity, unit price and line total;
  - invoice lines from `invoice_items`;
  - ticket lines: the event name, with ticket type × quantity once issuance state exists.
  - A failed lookup gives no items, and the receipt still goes out.
- **`lib/payments/entity-balance.ts`:** `getEntityBalance` also accepts `orderId`, using the same #381 payment-history rule. Existing booking and reservation callers are unchanged.
- **`lib/payments/send-confirmation.ts`:**
  - **Invoices:** the invoice lookup no longer selects the missing `description`, so online invoice payments resolve their business again. Before this, they returned `no_business_resolved` and sent nothing. The service line is now "Invoice <ref>".
  - **Tickets:** they name the event instead of "Payment". This also changes the "📋" line of the customer's WhatsApp confirmation and the owner's payment email.
  - **What the receipt receives:**
    - the items for orders, invoices and tickets;
    - deposit lines for bookings, reservations and orders;
    - the buyer's name, taken from the booking guest, reservation guest, invoice customer or donor, and otherwise from the account profile.
  - **The owner's order alert** (both the manifest and the legacy path) now selects existing columns and lists product names. Before, its query failed and the alert was skipped.
- **`lib/bot/flows/shared/post-completion.ts`:**
  - **New receipt-only options:** `receiptCustomerName`, `receiptItems`, `receiptTotalDue` and `receiptBalanceDue`.
  - **Unchanged:** `customerName` still drives the CRM profile and loyalty name.
- **`lib/receipts/generate-direct.ts`** (the "receipt" command):
  - **Donations:** it uses `campaigns.title`, so a paid donation can be found.
  - **Unpaid bookings:** pending (unpaid) bookings are no longer offered as receipts.
  - **Currency:** it uses the payment's or donation's own currency.
  - **Logo:** payment receipts include the logo.
  - **Items:** order and ticket receipts list items.
  - **Part-paid bookings:** these show the amount paid and the balance due, instead of the full price as if it were paid.
- **Tests:**
  - new:
    - `lib/pdf/__tests__/receipt-items-889.test.ts`
    - `lib/__tests__/receipts-confirmation-889.test.ts`
    - `lib/__tests__/receipt-command-889.test.ts`
    - `lib/__tests__/receipt-line-items-889.test.ts`
  - extended: `lib/pdf/__tests__/receipt-caller-level.test.ts`

**Affects:**
- Every payment receipt PDF.
- The customer's WhatsApp confirmation for tickets and invoices (the "📋" line).
- The owner's new-order WhatsApp alert.
- The "receipt" command.

**Unchanged:**
- Amounts charged, currency, fees and payment routes.
- Which effects run.
- The CRM and loyalty names.

**Could break:**
- **Item totals:** the item lines may not add up to the total paid when an order has delivery, add-ons or a discount. The total printed is still the amount actually paid.
- **Ticket type:** this shows only once ticket issuance state exists. Until then, the ticket line uses the event name.
- **Rounding:** the ticket unit price is the booking total divided by the quantity.
- **"Receipt" command:**
  - it still has no items for invoices;
  - booking rows have no currency column, so they use the business country, as before.
- **Unchanged pre-existing gap:** the `.or()` phone filter in `generate-direct.ts` still does not use `sanitizeFilterValue`. It is recorded as a separate finding, not changed here.
