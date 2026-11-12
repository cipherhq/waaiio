# Admin order reads and readable settings

- Correct order customer/amount/item displays through an order-scoped protected read endpoint for admin, support and operations.
- Correct Class Sessions pagination and detail rendering, and distinguish channel loading failures from empty results.
- Replace supported raw settings/payload editing with labelled controls while preserving storage and authorization contracts.

No payment writes, migrations, provider operations or deployment. See docs/contracts/admin-read-settings-fixes.md for acceptance scope.
