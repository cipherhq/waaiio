## 2026-11-06 — Bot: typed "updates" and My Account "Get updates" (#591 Part B)

Owner decisions 2026-11-06 on #591: Q6, customers can ask for updates in **My Account** and by typing **"updates"** (or "get updates"), but not from the main menu; Q1, one Yes covers marketing **and** utility; Q3, STOP wins. This reuses #942's `recordUpdatesOptIn`; there is no migration.

- **What changed**
  - `lib/bot/customer-updates-optin.ts`: new sources `keyword` and `account`, with evidence values `bot_updates_keyword` and `bot_my_account_menu`.
    - `askUpdatesOptIn` sends the confirmation "Get offers and updates from {Business} (and Waaiio) on WhatsApp? You can reply STOP any time." with **Yes, get updates** / **No thanks**. If the customer already agreed or unsubscribed, it uses the #942 wording instead. It records nothing.
    - `handleUpdatesConfirmTap` handles the Yes, whose id is `updates_yes:<keyword|account>:<businessId>`. It records only on a real button tap, and only when the id's business is the business of the chat the customer is in now. Otherwise it records nothing and replies "That option is no longer available".
    - `updatesAccountRowFor` builds the My Account row. It uses the same who-sees-it rule as the #942 row.
    - #942's own tap ids (`menu`/`welcome`) and hook are unchanged.
  - `lib/bot/bot.service.ts`:
    - **Typed keyword.** Handled in the unified-keyword block, under the same free-text and step-owned guards as every other keyword. The business is the chat session's business only.
    - **No business yet (shared number).** Typing the keyword before a business is chosen replies "Choose a business first…", unless a business's code is "updates".
    - **Yes / No thanks taps.** Handled right after the global queries, and they leave the chat session as it was. A recorded Yes, or a No thanks, ends with the next-steps menu (My Account if the customer has an account, View Options, Search directory on a shared number) and "Powered by Waaiio.com" (hidden for white-label).
  - `lib/bot/flows/capability-selection.flow.ts`: My Account gets "🎁 Get updates" as its last row before Back. The row is added only if it fits within WhatsApp's 10-row limit; it never pushes an existing row out. It is hidden once the customer has agreed or after a STOP. Tapping it sends the same confirmation and keeps the chat on My Account without re-sending the list.
  - `lib/bot/flows/flow-localization.ts`: 7 new `updates.*` keys in all 8 locales, added to the button, list, placeholder, command and native-review registries.
  - `lib/__tests__/helpers/memory-db.ts`: case-insensitive `ilike` (no wildcards), for the bot-code check.
- **Owner decision 2026-11-06 (relayed by the coordinator): latest row wins.** An earlier "No thanks" (a `revoked` marketing or utility consent) no longer blocks a later explicit Yes on any opt-in path: the #942 menu and welcome rows, the typed-keyword confirmation, and My Account.
  - `recordUpdatesOptIn` now appends granted marketing + utility rows over a revoked one.
  - Unchanged: `granted` still returns `already`; an active STOP (business or global) still blocks and returns `opted_out`; the channel and business checks are the same.
  - A revoked customer still does not get the offer row shown again (#942's visibility rule is unchanged). The typed keyword asks them as usual.
  - #942's tests that asserted "revoked blocks" were updated to the new behaviour, and a test was added for revoked plus an active STOP, which is still blocked.
- **Unchanged:** the main menu (#507), payment code, #942's menu and welcome rows, STOP/START words, and Forms/broadcasts.
- **What could break:**
  - A merchant keyword "updates" is now answered by this built-in word first.
  - A customer on a business's own number with no open chat who types "updates" gets the normal welcome, not the confirmation.
  - With many My Account rows (9 or more before Back), the row is not shown; typing "updates" still works.
