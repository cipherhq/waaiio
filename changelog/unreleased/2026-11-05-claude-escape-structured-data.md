## 2026-11-05 — Escape structured data output on public pages

- **What changed:** new `lib/utils/json-ld.ts` (`serializeJsonLd`) escapes `<`, `>`, `&`, U+2028 and U+2029 as `\uXXXX` when writing structured data (JSON-LD) into a `<script type="application/ld+json">` tag. Used by the public business page (`app/b/[slug]/page.tsx`), the public event page (`app/e/[slug]/page.tsx`) and the homepage (`app/(marketing)/page.tsx`) instead of plain `JSON.stringify`.
- **Tests:** `lib/__tests__/structured-data-escaping.test.tsx` renders both public pages and checks the structured data stays inside its tag and parses to the same values; ordinary text is unchanged. The page tests fail on the previous code.
- **Affects:** the structured data that search engines read on public business, event and home pages. The parsed values are identical.
- **Could break:** nothing expected; the output is still valid JSON with the same parsed value.
