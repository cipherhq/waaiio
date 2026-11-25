## 2026-11-24 — Big shop catalogs no longer break the WhatsApp order menu, and every product can be reached

**What changed:** WhatsApp lists allow at most 10 rows in total. A shop with more than 10 products in several categories (staging: Simi Scents, 22 products) got a 17-row list, and Meta refused it (131009, Sentry JAVASCRIPT-NEXTJS-B/C). Products past the 10th in one category could never be reached. Owner decision 2026-11-24: keep all 22 products, fix the bug.
- Opening the shop: when the catalog has more than 10 products in more than one category, the bot shows the category list first, the same list as "browse by category" mode. With one category, products come in pages with a "More Options →" row and a "← Previous" row. These reuse the existing `nav.more_options` / `nav.previous_page` copy that the main menu pages already use.
- Inside a category: every product is now listed through pages. Before, only the first 9 were listed. "Back to categories" stays at the top of every page.
- More than 10 categories: the category list is paged the same way.
- "Add more items or checkout" after adding to the cart, and the cart list: Checkout stays at the top of every page. Up to 9 products are listed beside it, the same as before. A bigger catalog lists its categories (several categories) or pages its products (one category).
- Products with no category, listed under "Menu", now open correctly from the category list. Before, tapping "Menu" showed nothing, because the bot searched for products whose category is literally "Menu".
- Backstop in the Meta sender: a list that still has more than 10 rows, or duplicate row ids, is cut to fit and logged as an error, so Meta no longer refuses it. Paging is the fix. The backstop only catches a future caller that forgets to page.

**Files:** `lib/bot/flows/shared/list-pages.ts` (new paging helper), `lib/bot/flows/ordering.flow.ts` (`browse_catalog`, `browse_category_items`, `add_to_cart`, `continue_or_checkout`), `lib/channels/meta-cloud.ts` (`sendList` backstop), `lib/bot/flows/__tests__/ordering-list-limits.test.ts` (new).

**Affects:** The ordering bot for shops with more than 10 products in a list. Shops with 9 or fewer products see exactly the same lists as before. At exactly 10 products, three lists change:
- A category with exactly 10 products now shows 8 plus "More". Before, it listed 9 and hid the 10th.
- With one category, the "add more items or checkout" list and the cart list now show Checkout, 8 products and "More". Before, they showed Checkout and 9 products, and the 10th was hidden.
- With several categories, those two lists now show Checkout and the categories. Before, they had 11 rows, which Meta refused.

The first list of a 10-product shop with several categories is still the plain list of products, as before. Browse-by-category mode after adding to the cart still uses its two buttons. No change to the cart, prices, checkout or payment.

**What could break:** Known limit, not changed: the shop and cart lists read a shop's first 100 products, as before. A shop with more than 100 products cannot reach the rest from those lists. The category view filters by category in the database, so it reads up to 100 products per category. New session keys `_browse_page`, `_category_page` and `_cart_page` hold the page numbers. A page number past the end shows the last page. Tapping a "More" row from an older list moves the current list one page on, which is harmless. Not changed: variant and add-on lists with more than 10 options. They never exceed 10 rows, but options past the 10th are still hidden, as before.
