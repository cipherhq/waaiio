## 2026-11-11 — Admin order reads and readable settings

- Correct order customer/amount/item displays through an order-scoped protected read endpoint for admin, support and operations.
- Correct Class Sessions pagination and detail rendering, and distinguish channel loading failures from empty results.
- Replace supported raw settings/payload editing with labelled controls while preserving storage and authorization contracts.
- Plan limit controls (max bookings, broadcasts, recipients) never write 0 when "Unlimited" is unticked: they restore the stored limit or require a whole number above 0 before saving. An existing 0 (Starter broadcasts) is kept.
- Flat number settings (e.g. monthly conversation limits) never save 0 when a field is cleared: the field stays empty and Save is blocked until a number is entered; conversation limits need a whole number above 0 or 999999999 (unlimited).

No payment writes, migrations, provider operations or deployment. See docs/contracts/admin-read-settings-fixes.md for acceptance scope.
