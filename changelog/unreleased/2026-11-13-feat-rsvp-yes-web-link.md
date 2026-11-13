## 2026-11-13 — Party RSVP: after Yes, send one link to the RSVP page instead of chat questions (#1005 PR 3a)

- **Why:**
  - Owner decision on #1005 (2026-11-13): "Link first, then form".
  - When a guest tapped Yes on a party that has questions, the bot asked guest count, dietary needs and every question one message at a time. Each message is billed and slow for the guest.
- **What changed:**
  - `lib/bot/bot.service.ts`: on a Yes tap for a party with questions, the new `sendPartyRsvpLink` sends one message with `/rsvp/<token>?rsvp=yes`. That page already asks everything at once and saves through the same API.
  - If that message cannot be sent, the bot falls back to today's one-by-one questions.
  - `app/rsvp/[token]/page.tsx`: `?rsvp=yes` pre-selects Yes, only for a guest who has not answered yet.
- **Affects:** Yes taps on party invites that have RSVP questions (template buttons and in-chat buttons).
- **Unchanged:**
  - Maybe and No.
  - Yes on parties without questions.
  - Events.
  - The sender phone check.
  - The RSVP page's save path and its capacity and required-answer checks.
- **Could break:**
  - The guest's RSVP is not saved until they submit the page. A guest who taps Yes and never opens the link stays "pending" (before, they stayed pending until the chat questions finished).
  - The link message is in English.
- **Tests:** `lib/__tests__/party-questions-botservice-489.test.ts`, `lib/__tests__/party-questions-ui-489.test.tsx`
