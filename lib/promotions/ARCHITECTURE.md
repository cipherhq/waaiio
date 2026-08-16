# Promotions Architecture (PROMO-1)

## Overview
WhatsApp-based consumer promotion system with unique codes. Businesses create promotions, generate/import codes with pre-assigned outcomes, and customers verify codes via WhatsApp for instant results.

## Code Lifecycle
1. **Generation/Import** - Codes created via batch generation (crypto-secure random) or CSV import
2. **Normalization** - `normalizePromoCode()`: trim, uppercase, strip separators. ONE function used everywhere.
3. **Hashing** - `hashPromoCode()`: HMAC-SHA256 for indexed lookup. Never store raw codes in DB.
4. **Encryption** - `encryptPromoCode()`: AES-256-GCM for recoverable storage (export/recovery).
5. **Storage** - `promo_campaign_codes` table: hash for lookup, encrypted for recovery, display_suffix for masked display.
6. **Outcome Assignment** - Winners assigned deterministically at generation time using Fisher-Yates shuffle with crypto.randomInt. NOT at redemption time.

## Claim Lifecycle
1. Customer sends code via WhatsApp (keyword or bare-code mode)
2. Bot handler (`promo-verification.ts`) detects promo attempt
3. `verifyPromoCode()` resolves campaign, normalizes code, hashes it
4. `claim_promo_code()` PostgreSQL function executes atomically:
   - Idempotency check (WhatsApp message ID)
   - Campaign validation (status, dates, business)
   - Rate limiting (window + total attempts)
   - Code lookup with FOR UPDATE lock
   - Status check (unused/claimed/void)
   - Atomic claim + redemption insert + attempt log
5. Response message sent using campaign's configured templates

## Security Model
- **No plaintext codes in DB** - HMAC hash for lookup, AES-256-GCM for recovery
- **Row-level locking** - FOR UPDATE prevents concurrent double-claims
- **Unique constraints** - `uq_promo_code_hash` (business-scoped), `uq_promo_redemption_code`, `uq_promo_redemption_message`
- **RLS** - All tables have RLS. `promo_campaign_codes` has NO client SELECT policy (codes are sensitive). Service role only.
- **Rate limiting** - Configurable per-phone window + total attempts
- **Cross-business isolation** - business_id on every table, enforced by RLS and claim function
- **Dashboard masking** - Codes displayed as `K7PM••••N2WF`, never raw

## Winner Allocation
- Deterministic: prizes assigned to specific code positions at generation time
- Fisher-Yates shuffle with `crypto.randomInt` for secure random placement
- Prize `allocated_count` tracks assigned vs configured `quantity`
- Campaign activation validates: allocated winners match prize inventory exactly

## WhatsApp Routing
- **Keyword mode**: "PROMO K7PM-4XQ9-N2WF" - first word matches campaign keyword
- **Bare code mode**: "K7PM-4XQ9-N2WF" - requires single active bare-code campaign per business
- **Safety**: Only triggers for businesses with `promo_verification` capability
- **Priority**: After escape hatches, BEFORE unified keyword matching
- **Non-interference**: Promo handler returns `{ handled: false }` if no match, bot continues normal routing

## Idempotency
- WhatsApp message ID stored on redemption (`uq_promo_redemption_message`)
- Same message retry returns same result (checked first in claim function)
- No second prize consumption on webhook retry

## Scaling Strategy
- Code generation: 1000 codes per chunk, batched INSERT
- Progress tracked via `promo_code_batches.progress_cursor` (resumable)
- Dashboard pagination: never loads all codes
- CSV export: streamed in chunks (PAGE_SIZE=1000)
- Indexed lookups: `idx_promo_campaign_codes_lookup` on (business_id, campaign_id, normalized_code_hash)

## V1 Exclusions
- No automatic payouts/bank transfers/airtime (manual fulfillment only)
- No anti-counterfeit/product authentication UI
- No real-time eligibility verification (age/geo are self-declared)
- No multi-channel (WhatsApp only)
