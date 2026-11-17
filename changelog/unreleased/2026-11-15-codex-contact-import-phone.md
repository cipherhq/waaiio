## 2026-11-15 — Validate contact import phone numbers

Customer CSV previews and the customer import API share import-specific international phone validation. Valid country-coded strings normalize to the existing customer identity key; invalid numbering plans, overlong values, scientific notation, extensions and non-string phones are rejected before writes. Local numbers without country context are not guessed.

Files: customer dashboard import, customer import API, import phone helper and rendered/API/normalization regression tests. Tenant ownership checks, `business_id,phone` upserts, other contact fields, consent state and general phone helpers are unchanged.

Potential breakage: previously accepted invalid/local phone values now need correction before import; regression tests cover mixed batches, international formats, duplicate identity normalization and denied ownership.
