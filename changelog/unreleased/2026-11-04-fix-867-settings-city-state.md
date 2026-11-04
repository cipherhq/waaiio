## 2026-11-04 — Settings: owners can see and correct City and State (#867, part 2)

- Problem: Settings → Business showed only one Address field. `city` was set silently from address autocomplete, and typing an address blanked it. `state` was never editable outside onboarding, so wrong values such as a Lagos business stored as state "Maryland" could not be fixed. Directory location search reads these columns.
- `app/dashboard/settings/tabs/BusinessTab.tsx`:
  - new editable "City or area" (max 50) and "State" (max 100) fields under Address, with help text linked to both;
  - picking an address suggestion fills both;
  - typing an address by hand still clears City and State, along with the coordinates (#485 kept), and the owner re-enters them;
  - `businesses.city` is NOT NULL, so saving with City empty now shows "Enter your city or area before saving." instead of a failed save. On main, a manual address edit followed by save sent `city: null` and failed;
  - State saves trimmed, or null when empty.
- `components/ui/PlacesAutocomplete.tsx`: place data now also carries `state` (Google `administrative_area_level_1`). It is optional, so other users of the component are unchanged.
- `components/dashboard/DashboardProvider.tsx`: `Business` type gains optional `state` (the row was already loaded with `select('*')`).
- Tests:
  - `app/dashboard/settings/tabs/__tests__/business-tab-city-state-867.test.tsx` (6, rendered).
  - `address-forms-751`, `discovery-settings-wiring-485` and `places-autocomplete-751` were updated to the required-City rule and the extra `state` field. Their #485 intent, that a manual edit invalidates coordinates and city, is kept.
- Not changed:
  - the Discovery Profile page (still writes city only; follow-up);
  - onboarding;
  - the guarded server-only columns (`city` and `state` are owner-writable today);
  - State is free text, not a dropdown, because the code has no complete state list per country.
- Could break: owners now see City and State values that autocomplete chose and may edit them; directory location search uses what they save.
