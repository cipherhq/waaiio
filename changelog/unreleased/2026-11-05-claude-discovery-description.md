## 2026-11-05 — Discovery Profile: fill in the business Description on the page

Owner decision (2026-11-05): add the field to the Discovery page, and make the Logo and Business Hours items link to Settings.

What changed:
- **Description field** (`app/dashboard/discovery/page.tsx`): Profile Details now has a "Description" box above the Short Listing Summary. It is the same business description as Settings → Business (`businesses.description`, also shown on the booking page). Saving the Discovery page now writes it, so the "Description" missing item can be cleared here. Previously the page only checked this field and could not edit it.
- **Settings links**: the "Logo" and "Business Hours" missing items are now links, marked "(in Settings)". Logo opens Settings → Business. Business Hours opens Settings → Business with the Operating Hours section open.
- **Settings** (`app/dashboard/settings/page.tsx`): `?tab=business&section=hours` opens the Operating Hours section as well as Profile.
- **Tests:** new rendered test `lib/__tests__/discovery-description-field.test.tsx` (field shows, loads, saves `description` separately from `discovery_description`; chip links). `lib/__tests__/discovery-settings-wiring-485.test.ts` used to pin "Discovery does not write `description`". It now checks that the payload writes it once, alongside `discovery_description`.

Affects: the Discovery Profile page and the Settings deep link for operating hours. No database or API change; the save uses the same owner-scoped `businesses` update the page already used.

Could break:
- If someone edits the description in Settings in another tab and then saves an older open Discovery page, the older text wins. The same was already true for address and other shared fields on this page.
