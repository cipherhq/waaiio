## 2026-11-06 — Contact page: direct WhatsApp chat links to the team

- `app/(marketing)/contact/page.tsx`: new "Chat with us on WhatsApp" section under the page heading with two WhatsApp-green buttons that open a chat directly: **United States +1 571 274 6425** (`https://wa.me/15712746425`) and **Nigeria +234 906 627 0361** (`https://wa.me/2349066270361`). Owner request 2026-11-06. Links open in a new tab with `rel="noopener noreferrer"`. Dark text on WhatsApp green for readable contrast; side by side on larger screens, stacked on phones. The existing cards (email, the +1 202 922 6251 WhatsApp card, location, specific enquiries) and the contact form are unchanged.
- `app/(marketing)/contact/__tests__/contact-whatsapp-links.test.tsx`: renders the page and checks both links (href, new tab, rel, country label and number) and that the existing contact details are still shown.
- Affects: the public `/contact` page only. The footer, the floating WhatsApp button and the help page still use their own numbers (not changed here).
- Note: the 2026-05-15 changelog moved the floating button **off** `15712746425` (then called a personal number) onto the shared `12029226251`. This change adds `15712746425` back on the contact page only, at the Owner's explicit request.
- Could break: nothing else; no shared code, API or data change.
