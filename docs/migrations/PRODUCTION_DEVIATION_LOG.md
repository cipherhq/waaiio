# Production Migration History Deviation Log

## Incident: Bulk `migration repair --status applied` on 14 Excluded Versions

**Date:** During production release preparation (August 2026)
**Action taken:** `supabase migration repair --status applied` was run on 14 migration versions that were intentionally excluded from repair.
**Effect:** Production `schema_migrations` table now contains rows for these 14 versions, marking them as "applied" despite their SQL never being executed.

### Impact Assessment

**No production schema damage.** `supabase migration repair` only inserts metadata rows into `schema_migrations` — it does NOT execute migration SQL. The production database schema is unchanged. The deviation is purely in migration-tracking metadata.

**Future `supabase db push` safety:** These versions will now be treated as already applied by Supabase tooling. Since their SQL was never executed, any schema objects they would have created either:
- Already exist (created by subsequent migrations or manual application), or
- Do not exist (NOT_VERIFIABLE_SAFELY content like keyword updates, label changes)

### Affected Versions

| Version | Filename | Original Classification | Reason Excluded |
|---------|----------|------------------------|-----------------|
| 101 | 101_fix_church_mosque_labels.sql | NOT_VERIFIABLE_SAFELY | Record-level content changes unverifiable via schema inspection |
| 105 | 105_category_groups.sql | NOT_VERIFIABLE_SAFELY | Record-level content changes unverifiable via schema inspection |
| 107 | 107_service_type.sql | NOT_VERIFIABLE_SAFELY | Record-level content changes unverifiable via schema inspection |
| 122 | 122_shared_channel_read_policy.sql | SUPERSEDED_WITH_EQUIVALENT_STATE | Policy replaced by later migration |
| 126 | 126_new_capability_types.sql | NOT_VERIFIABLE_SAFELY | Enum value additions unverifiable without runtime testing |
| 130 | 130_rsvp_invites.sql | SUPERSEDED_WITH_EQUIVALENT_STATE | Schema superseded by later migration |
| 160 | 160_subscription_one_per_business.sql | NOT_VERIFIABLE_SAFELY | Constraint behavior unverifiable via metadata alone |
| 163 | 163_fix_church_giving_keywords.sql | NOT_VERIFIABLE_SAFELY | Record-level content changes unverifiable |
| 164 | 164_fix_keyword_routing.sql | NOT_VERIFIABLE_SAFELY | Record-level content changes unverifiable |
| 187 | 187_waiver_short_token.sql | NOT_VERIFIABLE_SAFELY | Token generation behavior unverifiable via metadata |
| 216 | 216_annual_discount_setting.sql | NOT_VERIFIABLE_SAFELY | Settings value unverifiable via schema inspection |
| 217 | 217_configurable_settings.sql | NOT_VERIFIABLE_SAFELY | Settings value unverifiable via schema inspection |
| 222 | 222_payout_verification_limits.sql | NOT_VERIFIABLE_SAFELY | Settings value unverifiable via schema inspection |
| 226 | 226_refund_keyword.sql | NOT_VERIFIABLE_SAFELY | Record-level content changes unverifiable |

### Canonical Treatment

These 14 versions are now **APPLIED_WITHOUT_EXECUTION** in production. This status means:
1. Production `schema_migrations` says they are applied.
2. Their SQL was NOT executed against production.
3. Their effects may or may not exist in production depending on subsequent migrations.
4. They MUST NOT be re-executed or rolled back.
5. Future migration tooling must treat them as applied.

### Prevention

The `migration-repair-guard.ts` script and associated CI test prevent:
- `migration repair` on NOT_VERIFIABLE_SAFELY versions
- `migration repair` on SUPERSEDED versions
- Bulk repair without per-version allowlist evidence
- Any repair that bypasses the reconciliation manifest
