## 2026-11-19 — Messaging config save keeps currencies with no listed country

- **Problem:** in admin Countries → Messaging Financial Controls, **Save Messaging Config** failed with "GHS: Spend Cap is required…" when the saved config still held a currency (here GHS) whose market is no longer in the country list. The form only builds rows for currencies of listed countries, so that currency was missing from the payload and the dropped-currency guard refused the save. This blocked setting the Service Replies Rate to 0.
- **Change (`admin/src/pages/Countries.tsx`):** the loaded config snapshot is kept, and new `carryUnlistedCurrencies()` copies every value of a currency that no listed country uses (its `messaging_pricing` bucket, trial credit, and included credit for each tier) into the save payload unchanged. The dropped-currency guard skips only the currencies carried that way. No row is added to the form for them.
- **Unchanged:** a listed currency with an empty Spend Cap is still refused before any MFA request. The step-up binding, the server route, the database save function, the rate rules for listed markets, and the lookup of charges are all unchanged. No migration.
- **Tests (`admin/src/__tests__/countries-messaging-controls.test.tsx`):**
  - an unlisted GHS saves with its bucket identical byte-for-byte and its credits kept, while NG and US save Service Replies Rate 0;
  - with GHS unlisted, a cleared USD Spend Cap is still refused, naming only USD, with no MFA request.
  - Both fail without the fix.
- **Could break:** a hidden market's messaging values can't be edited from this form; they are kept as saved. Rates for a country that is not listed but whose currency is listed are still not carried (existing behaviour, not changed here).
