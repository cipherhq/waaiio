# Messaging Top-Up Package Pricing Proposal

**Issue:** #491
**Date:** 2026-10-08
**Status:** PENDING CTO APPROVAL — do not configure until approved

## Proposed Packages (Small / Medium / Large)

All amounts in integer minor currency units (cents/kobo/pesewas).

### USD (US, via Stripe)
| Size | Amount (minor) | Display | Approx. Messages* |
|------|---------------|---------|-------------------|
| Small | 500 | $5.00 | ~50 |
| Medium | 2000 | $20.00 | ~200 |
| Large | 5000 | $50.00 | ~500 |

### GBP (UK, via Stripe)
| Size | Amount (minor) | Display | Approx. Messages* |
|------|---------------|---------|-------------------|
| Small | 400 | \u00A34.00 | ~50 |
| Medium | 1500 | \u00A315.00 | ~200 |
| Large | 4000 | \u00A340.00 | ~500 |

### CAD (Canada, via Stripe)
| Size | Amount (minor) | Display | Approx. Messages* |
|------|---------------|---------|-------------------|
| Small | 700 | CA$7.00 | ~50 |
| Medium | 2500 | CA$25.00 | ~200 |
| Large | 7000 | CA$70.00 | ~500 |

### NGN (Nigeria, via Paystack)
| Size | Amount (minor) | Display | Approx. Messages* |
|------|---------------|---------|-------------------|
| Small | 50000 | \u20A6500 | ~100 |
| Medium | 200000 | \u20A62,000 | ~400 |
| Large | 500000 | \u20A65,000 | ~1,000 |

### GHS (Ghana, via Paystack)
| Size | Amount (minor) | Display | Approx. Messages* |
|------|---------------|---------|-------------------|
| Small | 2000 | GH\u20B520.00 | ~50 |
| Medium | 8000 | GH\u20B580.00 | ~200 |
| Large | 20000 | GH\u20B5200.00 | ~500 |

*Approximate message counts assume average per-message cost. Actual count depends on destination country and message category (utility vs marketing).

## Cost Assumptions

Pricing is based on Meta Cloud API per-conversation rates plus a Waaiio platform margin:
- **Meta costs** vary by destination country and message category
- **Platform margin** is the spread between Meta cost and the per-message rate in `messaging_pricing` config
- Approximate messages assumes the most common case: same-country utility messages

## Configuration Format

Once approved, the packages will be configured via `save_commercial_config`:

```json
{
  "USD": [
    { "amount_minor": 500, "label": "$5" },
    { "amount_minor": 2000, "label": "$20" },
    { "amount_minor": 5000, "label": "$50" }
  ],
  "GBP": [
    { "amount_minor": 400, "label": "\u00a34" },
    { "amount_minor": 1500, "label": "\u00a315" },
    { "amount_minor": 4000, "label": "\u00a340" }
  ],
  "CAD": [
    { "amount_minor": 700, "label": "CA$7" },
    { "amount_minor": 2500, "label": "CA$25" },
    { "amount_minor": 7000, "label": "CA$70" }
  ],
  "NGN": [
    { "amount_minor": 50000, "label": "\u20a6500" },
    { "amount_minor": 200000, "label": "\u20a62,000" },
    { "amount_minor": 500000, "label": "\u20a65,000" }
  ],
  "GHS": [
    { "amount_minor": 2000, "label": "GH\u20b520" },
    { "amount_minor": 8000, "label": "GH\u20b580" },
    { "amount_minor": 20000, "label": "GH\u20b5200" }
  ]
}
```

## Open Questions for CTO

1. Are these face values appropriate for the target market segments?
2. Should "description" fields with approximate message counts be included, or keep labels clean?
3. GHS packages: verify Paystack account capability for GHS transactions before configuring.
4. Should there be a "Custom" or enterprise tier with configurable amounts?

## Purchased Credit Expiry

Per CTO decision (Phase A review): **purchased credit does not expire while the business account remains active.** Implemented as `expires_at = NULL`. No additional policy approval needed.
