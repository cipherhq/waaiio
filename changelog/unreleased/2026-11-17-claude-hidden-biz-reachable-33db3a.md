## 2026-11-17 — Hidden businesses stay reachable for past customers (#1083)

- **Owner rule** (#1083, 2026-11-16): "yes hidden business customers can still patronize them".
  - A hidden business (merchant `discovery_enabled = false`, or the admin `platform_settings.directory_hidden` list) stays out of directory search for new customers.
  - Customers who used it before can still reach it and pay.
  - Inactive (`status <> 'active'`) or messaging-suspended businesses are reachable by no one.
- **Before:**
  - A hidden business was listed in a past customer's "You've used these businesses before" buttons. Tapping it then said "This business is currently unavailable", because the tap ran the full directory check.
  - A suspended business was also listed in those buttons.
  - Typing a suspended business's bot code on a shared number gave silence.
- **Changes:**
  - `lib/bot/handlers/directory-search.ts` `handleDirectorySelection`: a past-business tap (`dir_biz_<id>` found in the session's stored past list) now checks only that the business is reachable: active, has a bot code, and is not messaging-suspended. Search-result and close-match taps keep the full directory check. The check fails closed on a database error.
  - `lib/bot/handlers/bot-code-detection.ts` `findReturningCustomerBusinesses`: also requires `messaging_suspended = false`, so a suspended business is never offered as a past business.
  - `lib/bot/bot.service.ts` business entry: a messaging-suspended business gets the existing "This business is currently unavailable. Please try again later." reply. This only happens on a shared Waaiio number before the business is bound. On the business's own number (sender bound, or a dedicated-number lookup) the S-1 hard stop stays silent, as before.
- **Unchanged:** directory search, categories, `connect <name>`, the web directory, bot codes, `/m/` links, the close-name picker, blocked phones, the S-1 send guard and payments.
- **Tests:** `lib/bot/__tests__/hidden-business-reachable-1083.test.ts` (executable fake DB) and `lib/__tests__/hidden-business-reachable-botservice-1083.test.ts` (real `handleMessage`). The shared test fake `lib/marketplace/__tests__/helpers/directory-fake-db.ts` gains `in()`.
- **Could break:**
  - A past customer can now re-enter a business the admin hid from the directory. That is the Owner's rule. To keep someone out, suspend or deactivate the business, or block the phone.
  - Known gap, not changed here: the free-text close-name picker (`detectBotCodeWithSuggestions`) only checks `status = 'active'`, so it can still suggest a hidden or suspended business to a new customer.
