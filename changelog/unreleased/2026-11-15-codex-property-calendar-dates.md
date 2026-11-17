## 2026-11-15 — Keep property calendar dates on their saved day

The property detail calendar now iterates stored date-only reservation and blocked ranges with UTC calendar arithmetic, preventing the viewer's timezone or daylight-saving changes from shifting highlighted days. Reservation checkout remains excluded, blocked range endpoints remain included, and reservations retain display precedence.

Files: property detail dashboard and rendered calendar regression tests. This slice changes display only; it does not add blocking controls or change bookings, availability checks, database records, schema, prices or payments.

Potential breakage: incorrect range boundaries or month transitions; rendered tests cover Nigerian and US Eastern timezones, single-day/range blocks, checkout, year/leap boundaries and both DST transitions.
