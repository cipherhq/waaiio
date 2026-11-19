## 2026-11-19 — Faster bot replies, Batch 1: fewer repeated lookups, same replies

- **Why:** the Owner asked for any seconds or milliseconds that can be saved per bot step (2026-11-19). Staging measurements showed:
  - Vercel (iad1) and Supabase (us-east-1) are already in the same region;
  - every bot query runs in 0.1–4 ms inside the database;
  - the time goes on the number of sequential calls, about 40 ms each;
  - one real message made 43 calls in a row, several of them repeats.
  Batch 1 was approved by the Owner as "same bot replies".
- **What changed:**
  - `lib/bot/bot.service.ts`:
    - removed the `businesses.whatsapp_phone_number_id` lookup. That column does not exist on staging or production (checked 2026-11-19), so the lookup always failed and found nothing.
    - the suspension check is skipped when the webhook already ran it for this message (`markSuspensionGated()`). Other entries still check.
    - a number tap reuses the pending-STOP session read instead of repeating the identical query.
    - the business's wording overrides start loading as soon as the business is known.
  - `lib/bot/ai-config-reader.ts` (new), plus `bot.service.ts`, `flows/executor.ts` and `canonical-understanding.ts`: `ai_conversation_config` (languages and conversation config) is read at most once per business per message instead of up to five times. The executor's language read now runs alongside its other start-up checks.
  - `app/api/webhook/meta-cloud/route.ts`: tells the bot the suspension gate already ran.
  - `lib/bot/translate.ts`:
    - the translation feature flag (a remote PostHog call) is checked only for text that may actually be translated, i.e. after the short-text and nothing-to-translate skips.
    - a "yes" answer for a language is reused for 60 seconds. A "no" is not reused, because the flag client also returns "no" when PostHog fails.
  - `lib/bot/outbound-localizer.ts`: the parts of one list or buttons message are translated together instead of one after another.
  - `lib/bot/flows/scheduling.flow.ts`:
    - the time list's independent reads run together;
    - class "spots left" counts run together;
    - `select_service`'s prompt reuses the services list its `skipIf` read in the same step.
- **Measured** (old vs new code, real `BotService.handleMessage`, 40 ms per database call, median of 3 runs, WhatsApp send excluded):

  | Message | Old | New | Calls (old → new) |
  |---|---|---|---|
  | Menu tap | 944 ms | 801 ms | 26 → 24 |
  | Number tap | 836 ms | 678 ms | 25 → 22 |
  | Typed answer | 829 ms | 748 ms | 25 → 24 |
  | Free text | 859 ms | 733 ms | 26 → 24 |
  | Shared number | 1173 ms | 1081 ms | 34 → 32 |

  Translated (non-English) messages also save one remote flag call per string, and a list's four main parts no longer wait for each other.
- **Affects:** the bot's per-message lookups and outbound translation. Replies, flows, payments, consent, billing and sending are unchanged. Every scenario's replies equal those recorded from the old code (`lib/bot/__tests__/bot-latency-batch1.golden.json`, recorded at 6a94fabc8).
- **Could break:**
  - the suspension status is now read once per webhook message instead of twice. If that one read fails, the message goes through, as #1103 designed (fail-open); before, a second read could still have blocked it;
  - turning the translation flag off now takes effect within 60 seconds instead of immediately;
  - a business's language settings changed in the middle of handling one message are picked up on the next message.
- **Tests:**
  - New: `lib/bot/__tests__/bot-latency-batch1.test.ts`, `lib/bot/__tests__/bot-latency-batch1-botservice.test.ts`.
  - `acc-180-promo-behavioral`, `s1-botservice-real-handleMessage` and `stale-null-session` used to fake the missing column. They now follow production: the webhook supplies the business, or bot-code detection returns an exact match. The ACC-180 dedicated-number test now asserts the lookup is never made.
  - The webhook tests' BotService mocks gained `markSuspensionGated`.
