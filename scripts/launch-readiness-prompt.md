# Waaiio Launch Readiness — Full Application Audit Prompt

Use this prompt with Claude Code to run a comprehensive pre-launch audit across all dimensions.

---

## The Prompt

```
You are auditing Waaiio — a WhatsApp business automation platform launching in 5 countries (US, CA, NG, GH, UK). The app is at /Users/bajideace/Desktop/waaiio. It's Next.js 14 + React + Supabase + Tailwind, deployed on Vercel at waaiio.com.

Read CLAUDE.md and the memory files first for full context.

Run ALL of the following audits in parallel using agents. For each, report: what works, what's broken, what's confusing, and what's missing. Be specific — file paths, line numbers, exact text that needs changing.

---

## 1. ONBOARDING FLOW AUDIT
Test the full signup → business creation → first booking journey.

- Visit /get-started — is the value prop clear in 5 seconds?
- Read OnboardingWizard.tsx — trace every step. Where could a new user get stuck?
- Are form labels self-explanatory? Would a salon owner in Lagos understand every field?
- Is the category selection intuitive for 40+ industries?
- After onboarding, does the user know what to do next? Is there a setup checklist?
- How long does onboarding take? Count the steps. Can any be removed?
- Is there a skip option for non-critical steps?
- Test: what happens if you abandon halfway and come back?
- Check: is the WhatsApp connection step clear? Do they understand bot codes?
- Mobile: does onboarding work on a phone browser?

## 2. FIRST 5 MINUTES EXPERIENCE
After onboarding, what does the dashboard look like?

- Is the overview page overwhelming or helpful?
- Does the setup checklist guide them to the right next action?
- Are empty states actionable ("Add your first service" vs "No services")?
- Does the WhatsApp bot work immediately after setup?
- Can they test the bot themselves without a real customer?
- Is there inline help (tooltips, PageHelp banners) on every page?
- Are there any dead-end pages with no clear next action?

## 3. CUSTOMER JOURNEY AUDIT (WhatsApp)
Test as a CUSTOMER booking through WhatsApp for each business type:

- Salon: send bot code → select service → pick date → pick time → confirm → pay → get receipt
- Restaurant: send bot code → reserve → select date → guests → confirm
- Church: send bot code → give offering → enter amount → pay → get receipt
- Events: send bot code → select event → buy ticket → pay → get QR code
- Shop: send bot code → browse products → add to cart → checkout → pay → track order

For EACH flow:
- Is the greeting welcoming and clear?
- Does the bot explain what options are available?
- Are button labels clear (not jargon)?
- When something goes wrong, is the error message helpful?
- Can the user cancel at any step? What happens?
- Is the payment link clear? Does it work?
- Does the confirmation message include all needed info?
- Is the receipt/ticket delivered?

## 4. CUSTOMER JOURNEY AUDIT (Web)
Test the public web pages:

- /e/[slug] — can you buy a ticket without friction?
- /b/[slug] — can you book a service easily?
- Is email OTP smooth? How long does the code take?
- Is the T&C checkbox present?
- After payment, what does the success page show?
- Do you get an email confirmation?
- Can you find your ticket/receipt later?
- Mobile: do these pages work on phone?

## 5. MULTI-COUNTRY AUDIT
For each country (US, CA, NG, GH, UK):

- Is the currency correct? (USD, CAD, NGN, GHS, GBP)
- Are phone number formats handled? (+1, +234, +233, +44)
- Is the payment gateway correct? (Stripe for US/CA/UK, Paystack for NG/GH)
- Are date/time formats localized?
- Does the WhatsApp number work for that country?
- Are there any hardcoded US-centric assumptions?

## 6. PRICING & CONVERSION AUDIT
Check the pricing page and upgrade flow:

- /pricing — is it clear what free vs growth vs business includes?
- Can a free user do everything they need to validate the product?
- Is the upgrade prompt helpful (not pushy)?
- Does the capability gating make sense? (What happens when they hit a limit?)
- Is there a clear ROI message? ("Save X hours per week")
- Is there social proof? (Testimonials, business count, transaction count)

## 7. COPY & LANGUAGE AUDIT
Check ALL user-facing text for:

- Jargon that a non-technical business owner wouldn't understand
- Inconsistent terminology (booking vs appointment vs reservation — pick one per context)
- Grammar/spelling errors
- Messages that are too long or too short
- Error messages that don't explain what to do next
- Empty states that don't guide the user
- Button labels that are vague ("Submit" instead of "Save Settings")
- Tooltips that are confusing instead of helpful

Focus on: dashboard pages, bot messages, onboarding, marketing pages, email templates.

## 8. ACCESSIBILITY & MOBILE AUDIT
- Can you navigate the entire dashboard with keyboard only?
- Do all images have alt text?
- Do all form inputs have labels?
- Are color contrast ratios WCAG AA compliant?
- Does the dashboard work on mobile (320px-414px)?
- Are tap targets at least 44px?
- Does the sidebar work on tablets?
- Are there any horizontal scroll issues?

## 9. PERFORMANCE & RELIABILITY AUDIT
- Homepage load time (should be <2s)
- Dashboard load time (should be <3s)
- API response times under load
- What happens when Supabase is slow? (timeout handling)
- What happens when WhatsApp API is down? (graceful degradation)
- What happens when payment gateway is down?
- Are there any N+1 queries on dashboard pages?
- Are there any memory leaks in long-running pages?

## 10. SECURITY AUDIT
- Can a user access another business's data?
- Can an unauthenticated user access dashboard APIs?
- Are all webhooks verifying signatures?
- Are there any XSS vectors in user-generated content?
- Are redirect URLs validated?
- Is the admin panel properly gated?
- Are rate limits appropriate for each endpoint?
- Are secrets properly stored (not in VITE_ prefix, not hardcoded)?

## 11. SEO & DISCOVERABILITY AUDIT
- Does every marketing page have proper meta tags?
- Is the sitemap.xml complete?
- Is robots.txt correct?
- Are there JSON-LD structured data on key pages?
- Does llms.txt exist for AI search engines?
- Are OG images working for social sharing?
- Are canonical URLs set?
- Is the directory page indexable?

## 12. EMAIL & NOTIFICATION AUDIT
Test every email template:

- Booking confirmation email — does it have all details?
- Ticket email — does it include QR code?
- Invoice email — is it professional?
- Payment receipt — is it clear?
- Password reset — does it work?
- Are emails mobile-responsive?
- Do they render in Gmail, Outlook, Yahoo?
- Is the from address professional (not noreply@)?

## 13. EDGE CASE AUDIT
Test these specific scenarios:

- User buys ticket → cancels → tries to buy again
- Two users try to buy the last ticket simultaneously
- User starts booking → loses internet → comes back
- User with 0 balance tries to pay
- Business owner deletes a service while a customer is booking it
- Customer sends profanity
- Customer sends a voice note
- Customer sends an image
- Extremely long business name (50+ chars)
- Service price of 0 (free)
- Service price of 1,000,000+
- Event with 0 tickets remaining
- Booking on a day the business is closed
- Multiple bookings at the same time slot

---

## OUTPUT FORMAT

For each audit section, provide:

### [Section Name]
**Score: X/10**

**Working Well:**
- [List what's good]

**Issues Found:**
| Severity | Issue | File | Fix |
|----------|-------|------|-----|
| CRITICAL | ... | ... | ... |
| HIGH | ... | ... | ... |
| MEDIUM | ... | ... | ... |

**Quick Wins (< 30 min each):**
- [ ] Fix 1
- [ ] Fix 2

**Larger Improvements:**
- [ ] Improvement 1 (est. X hours)
```

---

## How to Run

1. Open Claude Code in the waaiio directory
2. Paste the prompt above
3. Claude will launch parallel agents for each section
4. Review the consolidated report
5. Fix critical issues first, then high, then medium
6. Re-run affected sections to verify fixes

## Recommended Schedule

- **Day 1:** Run full audit, fix CRITICAL issues
- **Day 2:** Fix HIGH issues, re-test affected flows
- **Day 3:** Fix MEDIUM issues, polish copy/UX
- **Day 4:** Final pass — re-run all audits, verify zero criticals
- **Day 5:** Launch 🚀
