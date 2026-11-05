## 2026-11-05 — Keep staging and the admin panels out of search engines

**What changed** (Owner request and approval, 2026-11-05)

- **Staging merchant site** (staging.waaiio.com and its `waaiio.vercel.app` alias), only when `isStagingTestMode()` is true:
  - every response the middleware handles carries `X-Robots-Tag: noindex, nofollow`;
  - `/robots.txt` is `User-agent: *` / `Disallow: /`;
  - `/sitemap.xml` returns 404;
  - the root layout adds `<meta name="robots" content="noindex, nofollow">`.
- **Both admin panels** (admin.waaiio.com and admin-staging.waaiio.com, same `admin/` code):
  - `X-Robots-Tag: noindex, nofollow` on every path (`admin/vercel.json`);
  - a new `admin/public/robots.txt` blocks everything. Before this, `/robots.txt` fell through to the single-page-app rewrite and returned `index.html`;
  - a robots meta tag in `admin/index.html`.
- **Production merchant site (www.waaiio.com) is unchanged.** It never matches `isStagingTestMode()`, which needs both the staging Vercel project ID and the staging Supabase URL. Its `app/robots.ts`, `app/sitemap.ts` and page metadata are untouched.
- **Files:** `middleware.ts`, `app/layout.tsx`, `admin/vercel.json`, `admin/index.html`, `admin/public/robots.txt` (new).

**Tests:** `lib/__tests__/search-noindex-staging-admin.test.ts` (new, 18 tests, runs in the full unit suite):
- real middleware on staging: robots.txt, sitemap 404, header on pages, API routes and redirects;
- real middleware on production: robots.txt and sitemap pass through, no header; a half-matching identity is treated as production;
- root layout metadata on staging and production;
- admin config: header rule, robots.txt and meta tag.
- Red check: on `main`, the 11 staging and admin tests fail and the 7 production tests pass.

**Could break:**
- The layout meta tag is computed when the page is built. If a staging build ever runs without `VERCEL_PROJECT_ID`, the tag is left out. The middleware header (checked on every request) still applies.
- The middleware does not run for `/_next/static`, `/_next/image`, `favicon.ico` or image files, so staging images and scripts get no header. They are also blocked by the staging robots.txt.
- Google can't read a noindex label on pages that robots.txt blocks it from crawling. Any staging page already in Google has to be removed in Search Console (an Owner action).
- Nothing changes for the release tool, CI or webhooks: they still reach staging, with one extra response header.
