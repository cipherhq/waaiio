# Pricing Sources

## Canonical Source

`lib/constants.ts` exports:

- `PRICING_TIERS` -- base tier config (name, price, feePercentage, feeFlat, maxBookings, features)
- `TIER_FEATURES` -- marketing names, descriptions, capabilities, highlights per tier
- `getPricingTiers(countryCode)` -- returns localized pricing (DB-backed country pricing with fallback)
- `formatCurrency(amount, countryCode)` -- formats amounts for display

## Files Using Dynamic Pricing (imports getPricingTiers / TIER_FEATURES)

| File | Method |
|------|--------|
| `app/(marketing)/pricing/page.tsx` | `getPricingTiers()`, `TIER_FEATURES`, `formatCurrency()` |
| `app/(marketing)/HomeClient.tsx` | `getPricingTiers()`, `formatCurrency()` |
| `app/get-started/OnboardingWizard.tsx` | `getPricingTiers()` |
| `app/dashboard/billing/page.tsx` | `getPricingTiers()` |
| `app/dashboard/settings/tabs/AccountTab.tsx` | `getPricingTiers()` |
| `lib/whitelabel.ts` | `PRICING_TIERS` |
| `lib/platformSettings.ts` | `PRICING_TIERS` |

## Files with No Hardcoded Prices

- `app/(marketing)/features/page.tsx` -- no price values at all
- `app/(marketing)/HomeClient.tsx` -- fully dynamic via `getPricingTiers()`

## Checklist for Updating Prices

- [ ] Update `PRICING_TIERS` in `lib/constants.ts` (base values)
- [ ] Update `TIER_FEATURES` in `lib/constants.ts` (highlights, descriptions)
- [ ] Update `COUNTRY_PRICING` in `lib/constants.ts` (per-country overrides)
- [ ] Or update the `countries` table in Supabase (DB pricing overrides constants)
- [ ] Run `npm run build` to verify no type errors
- [ ] Spot-check `/pricing` page for each country
- [ ] Spot-check homepage pricing preview section
- [ ] Verify bot flow messages in `lib/bot/flows/shared/post-completion.ts`
