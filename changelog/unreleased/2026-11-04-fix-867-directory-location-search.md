## 2026-11-04 — Directory search finds businesses by area, as customers type it (#867, part 1)

- Problem: in production, "Shop in ikoyi" returned 0 results although an eligible Ikoyi shop is listed. Address autocomplete stores the area in `city` ("Ikoyi") and the metro in `state` ("Lagos") with a bare street address. The search needed city = Lagos AND an address mentioning Ikoyi, so such businesses never matched.
- `lib/marketplace/search.ts`:
  - An area search now matches when city or address names the parent city and the address names the area, or when the city field is the area and state or address names the parent city.
  - State is never used on its own, so a business with only a wrong state stays excluded, as #584 required.
  - A city search ("shop in Lagos") also matches the address.
- `lib/marketplace/query-parser.ts`: "shops Ikoyi" and "Ikoyi shop" now read like "shop in Ikoyi". This applies only to messages of 2-5 words, where one side is a category or generic word and the other exactly names a curated city or area. Substrings such as "shop a" or "Salon East" are left alone.
- `lib/bot/handlers/directory-search.ts`: "businesses in Ikoyi" and "Ikoyi" search the place instead of looking for that literal phrase in names. "boutique in Ikoyi" searches the name "boutique". Text is dropped only when the place is a city or area. A bare word, a state ("Oyo") or a country ("Nigeria") keeps its text, so a search never lists a whole country (review r2 P1-1).
- Tests:
  - `lib/bot/__tests__/directory-search-867.test.ts` (new, 8);
  - new cases in `query-parser.test.ts` and `discovery-search-query.test.ts`. The test double now evaluates nested `and(...)` filters, and the real-client test checks the serialized filter.
  - 15 tests fail on the previous code.
- Not changed: the "did you mean" fallback (`search_businesses_fuzzy`, M447), the web directory, the settings page (#867 part 2), eligibility rules, ranking.
- Could break: area and city searches return more matches than before (businesses whose city or address names the place). The wrong-state exclusion is kept.
