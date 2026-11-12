# Admin read and settings correction contract

Owner authorizes surgical implementation in codex/admin-audit-fixes, without deployment.

## Accepted behavior
- Orders visible to admin, support and operations; those roles may read order-bound customer names/email and complete order details. Finance access and generic customer-query permissions remain unchanged.
- Recorded order total includes shipping; never add shipping twice or change major/minor units. No payment, payout, bot, migration or provider mutation.
- Class Sessions pager and detail use existing component contracts.
- Channel Changes failed load is not an empty-success result; retry does not enable channel operations.
- Human-readable setting editors preserve existing stored types, unknown payload fields, authoritative writers, MFA and validation. Raw JSON remains available for unsupported shapes. No pricing/verification policy changes.

## Dependencies and overlap
Graphify index f15d56d used as discovery only; source base f2fb0407960995fc63cba3f491e107406c895d35 and independent staging schema trace are authoritative. MCP open PRs #939, #945, #988 and #989 were checked; their file lists do not overlap this scope. Root checkout belongs to Claude and is not edited.

## Acceptance
Mounted tests for pager/detail/error-retry, canonical order display/total/detail binding, settings type preservation and payload preservation. HTTP tests for three allowed roles, denied finance/unauthenticated access, fixed projection, scoped joins, error vs not-found, currency and complete item counts. Existing MFA tests must remain passing. Build and changed-file type checks; disclose baseline errors and mocked provider/database boundaries. Independent final review required. No merge/deploy authorization.
