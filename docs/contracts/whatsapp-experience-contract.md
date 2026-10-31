# Shared WhatsApp Experience Contract

> **Authority:** Issue #721, Owner-approved WhatsApp bot experience standards.
> **Audit SHA:** `164b31b87fc8013dec65a55201ecaee30859a1b8`
> **Status:** Contract standard — not yet E2E certified.

---

## 1. Purpose

Waaiio's WhatsApp bot is the core product. This contract defines the shared customer experience standards that apply across all capabilities: entry, navigation, language, free-text handling, recovery, message efficiency, and channel boundaries.

---

## 2. Channel Models

### A. Shared Waaiio WhatsApp Numbers

Shared numbers serve multiple merchants on one WhatsApp conversation.

**Production number:** `+1 639-739-1803` (Waaiio App, account "Waaiio Bot")
**Staging number:** `+1 443-228-9898` (Citadel, account "waaiiogeneral")

**Customer entry — first time, general number:**
1. Customer messages the shared number
2. Waaiio responds with a greeting and language choice (certified languages: en, pcm)
3. Customer can search/browse the business directory
4. Customer selects a merchant
5. Bot enters that merchant's configured experience
6. Merchant's enabled capabilities become accessible

**Customer entry — first time, merchant-specific link:**
1. Customer opens the merchant's WhatsApp link (pre-filled message with business code)
2. Bot identifies the intended merchant via keyword/business-code detection
3. Customer receives merchant-specific greeting
4. Bot continues directly into the merchant's capabilities

**Merchant switching (shared number):**
- Customers may interact with multiple merchants in the same WhatsApp conversation **on the same shared number**
- Each merchant maintains separate session, cart, and transaction state
- Switching merchants does not contaminate the previous merchant's data
- Completed payment facts are preserved regardless of switching
- Same-conversation continuity applies only within a single WhatsApp phone number; two distinct Meta phone numbers are two distinct conversations regardless of Waaiio's application layer

### B. Dedicated Merchant Numbers

A dedicated number is tied to one merchant via `whatsapp_channels.business_id`.

**Rules:**
- Enters the merchant's experience directly
- Shows only that merchant's enabled capabilities
- No business directory or multi-merchant switching exposed
- Merchant identity comes from `channel.business_id` (authenticated, not customer text)

---

## 3. Returning Customer Experience

Waaiio remembers useful customer context securely:
- Previous merchant interactions (via `bot_sessions`, `bookings`, `customer_profiles`)
- Language preference (via session data)
- Customer profile data (name, email — via `customer_profiles`)

**Rules:**
- Do not repeatedly ask for data already safely available
- Never assume old prices or availability remain valid
- Never auto-charge a saved card without explicit confirmation
- Require confirmation before new financial commitments
- Offer an obvious way to start something new

---

## 4. Language Support

**Certified languages:** English (`en`), Nigerian Pidgin English (`pcm`)
**Other catalogued languages:** Not certified; do not activate without Owner approval.

**Target behavior (code paths exist; not all E2E verified):**
- Language choice offered on first visit
- Returning customers are not unnecessarily re-asked
- Mid-conversation language switch preserves session progress
- Payment status and transaction details remain unchanged on switch
- Names, prices, currencies, payment references, and links are protected from translation
- Unsupported languages fall back to English safely

**Evidence status:** Language infrastructure verified via code trace (`lib/bot/` translation modules). Mid-session language switch preservation and translation protection NOT verified end-to-end.

---

## 5. Free-Text and Natural Language

**Architecture:**
1. **Regex-first:** `lib/bot/smart-intent.ts` — deterministic keyword/pattern matching
2. **LLM fallback:** `lib/bot/llm-intent.ts` — Claude Haiku for ambiguous inputs (tier-gated)
3. **Entity extraction:** Contextual understanding of dates, quantities, service names

**Cost controls:**
- LLM intent cached for 5 minutes (normalized)
- `checkRateLimit('llm-intent-global', 30, 60_000)` — global LLM rate limit
- `lib/bot/ai-tier-guard.ts` — tier-based AI usage allowances
- Regex-first routing avoids LLM for deterministic commands

**Safety rules:**
- Never use AI classification as payment authority
- Never use AI classification as capability authorization
- Prevent prompt injection (input sanitization)
- Prevent cross-merchant state changes from free text

---

## 6. Conversation Navigation

**Escape hatches:** "cancel", "exit", "quit", "stop", "restart", "start over"
**Navigation:** "back", "menu", "help"
**STOP/UNSUBSCRIBE:** Merchant-specific opt-out (Owner Option A, PR #727)

**STOP behavior (current main, post-PR #727):**
- STOP before rate limit check — cannot be dropped by throttle
- Dedicated channel: uses `channel.business_id` directly
- Shared channel, single active session: uses `session.business_id`
- Shared channel, ambiguous: merchant picker → auto-complete STOP
- Dual-context (merchant + platform): Option C disambiguation prompt
- INSERT + 23505 with row-ID persistence proof
- Confirmation only after verified persistence
- Merchant STOP independent from platform launch announcements (Owner Decision 2)

---

## 7. Rate Limiting and Abuse Prevention

**Per-phone rate limit:** 20 messages/minute (configurable via `platformSettings`)
**Behavior on throttle:** Sends approved notice: "You're sending messages too quickly. Please wait a moment and try again." (Owner-approved Option A)

**Additional protections:**
- Message length cap (>5,000 chars silently discarded)
- Gibberish/profanity detection with cooldown (`lib/bot/bot-intelligence.ts`)
- LLM rate limiting (in-memory, per-instance)

**Known limitations:**
- Cross-instance rate limiter requires Redis (Upstash) — falls back to per-instance memory without it
- Profanity filter false positive: `PROFANITY_SET` contains "were" (common English past tense)

---

## 8. Message Efficiency Standards

**Principle:** Minimum conversation, maximum capability. Clear next action at every point.

**Audit targets per journey:**
- Customer messages to complete a journey
- Bot messages to complete a journey
- Unnecessary repeated prompts (language, info already collected)
- Duplicate outbound messages
- LLM classification invocations

**Rules:**
- Do not optimize by suppressing important messages
- Do not remove confirmation prompts for financial actions
- Do not skip consent verification for saved cards
- Preserve all mandatory security/safety messages

---

## 9. Meta Platform Constraints

**Customer service window:** 24 hours from last customer message (free-form replies eligible)
**Outside window:** Must use approved templates
**Template categories:** MARKETING, UTILITY, AUTHENTICATION
**Meta pricing (Oct 2026):** First 1,000 service messages/month/number free; then per-delivery charge

**Template inventory (production):**

| Name | Category | Use |
|---|---|---|
| `booking_confirmation` | UTILITY | Post-booking confirmation |
| `booking_reminder` | UTILITY | Reminder before appointment |
| `order_status_update` | UTILITY | Order status change |
| `invoice_payment_request` | UTILITY | Invoice payment link |
| `document_signature_request` | UTILITY | E-signature request |
| `waaiio_login_otp` | AUTHENTICATION | Login verification |
| `waaiio_event_invite` | MARKETING | Event invitation |
| `business_promotion` | MARKETING | Business promotion |
| `business_event` | MARKETING | Business event announcement |
| `business_reminder` | MARKETING | General business reminder |
| `business_update` | MARKETING | Business update |
| `feedback_request` | MARKETING | Post-service feedback |

---

## 10. Webhook Processing

**Entry:** `app/api/webhook/meta-cloud/route.ts`
**Signature validation:** HMAC verification using `META_APP_SECRET`
**Processing:** `phoneNumberId` → channel resolution → `handleMessage`

**Rules:**
- Verify Meta signature before processing
- Handle duplicate inbound events (message ID dedup)
- Handle out-of-order callbacks
- Preserve correct tenant resolution via `phoneNumberId` → `whatsapp_channels`
- Shared channel: `stripSharedChannelBusinessAuthority()` removes business_id
- Dedicated channel: preserves `channel.business_id`

---

## 11. Dashboard ↔ Bot Parity

**Binding requirement (Owner, 2026-10-27):** A merchant's dashboard configuration must match the capabilities shown and executable in their WhatsApp bot, one for one.

**Enforcement points:**
- Capability menu: `getUserFacingCapabilities()` filters by enabled + backing data
- Execution guard: `requireCurrentCapability()` at mutation time (queue, waitlist)
- `useRequireCapability()` hard gates on 8 dashboard pages
- Other dashboard pages rely on sidebar visibility only

**Known gap:** 13 orphaned dashboard pages exist with no sidebar entry (activity, guests, impersonate, insights, integrations, keywords, notifications, pages, rules, sequences, support, surveys, verification, whatsapp-usage, flow-editor).

---

## 12. Cross-Country Commerce

Waaiio supports international customer access. A customer in Nigeria may purchase from an eligible U.S. business, and vice versa.

**Rules:**
- Customer's country does not automatically limit merchant discovery
- Each merchant has its own checkout, transaction, receipt, and settlement
- Never create combined multi-merchant checkouts
- Display the merchant's transaction currency clearly
- Do not automatically substitute the customer's local currency
- Payment routing follows merchant country + configured provider (Stripe for US/UK/CA, Paystack for NG/GH)
- Fulfillment must respect merchant configuration and supported delivery/service areas
- Cross-country purchasing does not mean every merchant can serve everywhere

**Owner-approved rules (A8-A12):** Same shared conversation when technically supported; separate checkout/payment/receipt per merchant; preserve merchant-isolated carts with revalidation; display merchant's currency; respect merchant fulfillment configuration.

**Evidence status:** UNVERIFIED — no E2E evidence of cross-country merchant discovery or purchasing. Code architecture supports it via country-agnostic business directory; actual behavior requires staging test.

---

## 13. Merchant Isolation and Cart Preservation

### Shared Numbers

- Separate unfinished carts per merchant
- Separate completed transaction history per merchant
- No migration of one merchant's cart into another
- No mixing of order IDs, booking IDs, session data, payment references, discounts, or prices
- Revalidate saved carts before checkout (prices and availability may change)
- Completed payment facts preserved if customer switches merchants
- Independent receipts, notifications, settlements, and fulfillment per merchant

### Dedicated Numbers

- Merchant exclusivity enforced via `channel.business_id`
- No shared-directory switching exposed
- No cross-merchant data leakage

### Implementation (architecture verified via code trace; not E2E tested)

- `business_id` is the partition key across all tables
- RLS enforces tenant isolation at the database level
- Bot sessions scoped by `whatsapp_number` + `business_id`
- Payment records tied to specific `business_id`
- Session data isolated by business context

**Evidence status:** Architectural isolation verified via RLS policies, session schema, and payment table structure. Cart preservation during merchant switching, price revalidation on checkout, and cross-merchant data isolation NOT verified end-to-end. Staging E2E required.

---

## 14. Receipts and Confirmations

**Target behavior for every successful payment (code path exists; not E2E verified):**
- Customer receives WhatsApp confirmation (post-PR #722: with `messageCategory: 'utility'`)
- Merchant receives email notification (via `send-confirmation.ts`)
- Receipt generated (PDF where applicable, text fallback)

**Capability-specific confirmations (implementation exists; staging E2E not performed):**
- Ticketing: QR code ticket delivery via `sendTicketsAfterPurchase` (with dedup)
- Booking: Confirmation with reference code and details
- Ordering: Order confirmation with item summary
- Giving: Donation acknowledgment
- Invoice: Payment receipt with invoice reference

**Failure handling (design contract — not incident-tested):**
- Stage 3 notification failure does NOT undo Stage 1 payment or Stage 2 fulfillment
- Failed notification triggers auditable recovery path
- Never pretend payment failed or charge again automatically

**Evidence status:** Code paths verified via source trace. Actual WhatsApp delivery, merchant email receipt, and receipt PDF generation NOT verified end-to-end. Staging E2E required for certification.

---

## 15. Low-Literacy and Simple UX Standards

**Design principle:** A first-time customer, someone with limited reading ability, or a child old enough to use the service should be able to navigate without technical knowledge.

**Standards:**
- Use familiar everyday words
- One clear next action at a time where practical
- Obvious choices with short useful examples
- Simple error recovery with clear instructions
- Short, useful messages — do not omit important information to save length
- WhatsApp buttons (max 3) and lists for common choices
- Numbered options when more than 3 choices needed
- Clear success and failure messages with what to do next
- No technical jargon, internal IDs, or developer-facing error codes
- No excessive confirmation prompts, but preserve all financially consequential confirmations

**Meta platform constraints respected:**
- Maximum 3 quick-reply buttons per message
- Maximum 10 list rows per section
- 1024 character body limit for interactive messages
- Template required outside 24-hour customer service window

**Not currently supported (would require Owner approval as new features):**
- Voice note understanding
- Audio guidance
- Image-based menus
