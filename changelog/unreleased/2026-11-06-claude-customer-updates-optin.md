## 2026-11-06 — Customer updates opt-in on the next-steps and welcome menus

Owner decision 2026-11-06 (Option A): one tap to get offers and updates from **that business and Waaiio**, inside a menu the customer already receives.

- **What changed**
  - `lib/bot/customer-updates-optin.ts` (new): builds the opt-in row, decides who sees it, and handles the tap. A tap records an append-only `customer_consents` row (whatsapp / marketing / granted, `source='whatsapp'`, `evidence_reference` `bot_next_steps_menu` or `bot_welcome_menu`, `policy_version` `bot-updates-optin-v1:business+waaiio|business`, `granted_at`) and, unless the business is white-label, adds the number to Waaiio's updates list (`launch_subscribers`, `signup_source` as above), which STOP already offers as "Waaiio updates".
  - `lib/bot/flows/executor.ts` (`showPostCompletionMenu`) and `lib/payments/send-confirmation.ts` (Stage 3 menu): when the offer applies, the menu is sent as a list with the opt-in row first and every existing option and the "Powered by Waaiio.com" footer kept. Otherwise the menu is unchanged.
  - `lib/bot/flows/capability-selection.flow.ts`: a first-time customer's welcome menu (greeting shown, no history at this business) gets the row last, only when it fits on one page.
  - `lib/bot/bot.service.ts`: the tap (`updates_yes:<menu|welcome>:<businessId>`) is handled right after the launch opt-in hook, before any session routing. It never changes the chat session.
  - `lib/bot/flows/flow-localization.ts`: `updates.*` copy in all 8 locales, placeholder, list-title and command registries, and native-review entries for non-English locales. `updates.*` keys are platform-only, so businesses cannot edit the consent wording.
- **Rules enforced:** shown only to customers with no granted consent for that business; never shown to anyone who ever sent STOP to that business (even if later resubscribed), opted out globally, has a revoked consent, or unsubscribed from Waaiio updates (Waaiio-named offers only). Consent is per business: a tap counts only for a business this number has chatted with or is a customer of, and on a business's own number only for that business. Every read fails closed (no offer, nothing recorded).
- **No migration.** Uses existing columns and CHECK values only.
- **What could break:** menus for customers who have not opted in now arrive as a "View options" list instead of buttons (same options). Two or three extra reads per completion menu. New Waaiio-list members would also receive a re-sent Waaiio launch announcement.
