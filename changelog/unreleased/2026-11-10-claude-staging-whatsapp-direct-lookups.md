## 2026-11-10 — Staging: the remaining direct shared-number lookups use the designated US number

**Why:** follow-up to PR #970 (Owner rule 2026-11-10: every staging business, whatever its country, uses the US shared number +1 240 471 2139; production unchanged). Both #970 reviewers flagged server paths that still picked "a shared WhatsApp number" themselves (`channel_type = 'shared'` plus a country filter or `limit(1)`), bypassing the staging rule. While staging has a single shared channel most of these paths already landed on it; the exception found by code trace is merchant-notification WhatsApp invitations, which returned "not ready" for every non-US staging business (they looked for a shared number in the business's own country).

**What changed** (staging only; each production query is left exactly as it was)
- `lib/channels/staging-whatsapp-routing.ts`: new `loadStagingDesignatedChannel()` — reads the designated row by its pinned id and returns it only if `stagingDesignatedChannelProblem()` passes; the token columns are read only when asked for.
- `lib/channels/channel-resolver.ts`: `resolveByChannelIdForBusiness` refuses a shared channel other than the usable designated one in staging (every caller already handles `null`: it skips the send, or, for non-WhatsApp-origin confirmations, uses `resolveByBusinessId`, which #970 already made staging-safe).
- `app/api/auth/otp/send/route.ts`: the primary OTP sender is the designated number (Meta provider). If it is unusable the primary refuses and the existing env-credential fallback runs, as before.
- Links shown to customers: `app/api/checkin/route.ts`, `app/api/forms/public/[token]/route.ts`, `app/api/invoices/public/[token]/route.ts`, `app/payment-success/page.tsx` — the shared fallback is the designated number for any country; if it is unusable they fall back to the business phone, as they already did when no channel exists.
- `app/api/launch/regions/route.ts`: lists only the designated number (as a US region).
- `lib/launch/delivery.ts`: `resolveChannelCredentials` returns the designated number's credentials only when the subscriber signed up on it; otherwise none (delivery records `no_channel_credentials`, as before).
- `lib/merchant-notifications/enrollment.ts`: `sharedChannel` returns the designated number for any business country; a business pointed at another shared number gets none.
- `lib/bot/customer-updates-optin.ts`: the Waaiio sender recorded for a new launch subscriber is the designated number.
- Tests: `lib/__tests__/staging-direct-shared-lookups.test.ts`, `lib/__tests__/staging-payment-success-shared.test.tsx`, fixtures in `lib/__tests__/helpers/staging-channels.ts`.

**Not changed, on purpose:** inbound identification (`lib/bot/launch-optin.ts` market label, `lib/bot/bot.service.ts` shared-number country) — the number a message arrived on identifies the channel, as documented in `docs/WHATSAPP_ENVIRONMENT_ROUTING.md`; the dashboard shared-target preview (`app/api/settings/whatsapp-channel/route.ts`, authority is the `channel_change_shared_target` RPC); the admin campaign channel list; the `whatsapp_channels_public` fallback; the payment-success exact-origin path.

**Affects:** staging only at runtime. Production code paths run the same queries in the same order with the same results (tests record and compare the exact query chains).

**Could break:**
- In staging, if the designated row is missing, inactive, disconnected, owned or mismatched, these paths now show the business phone / send nothing instead of another shared number.
- Staging launch subscribers recorded on a number other than the designated one are no longer sent to (none expected: staging has one shared number).
