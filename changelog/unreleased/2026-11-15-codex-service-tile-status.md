## 2026-11-15 — Change service availability from its tile

Adds an Active/Inactive button to existing service and class tiles. The authenticated update changes only the paired status and availability fields, is scoped to the current business and undeleted service, and checks the expected status before saving. Tiles change only after the database returns the saved row; pending clicks are deduplicated and failed saves show the existing error message beside the tile.

Files: services dashboard and rendered interaction tests. Archived tiles retain their badge and edit behavior. Booking records, class sessions, pricing, schedules and the full edit form are unchanged.

Potential breakage: stale or failed saves must not show a false success; tests cover both directions, duplicate clicks, failed/empty responses, archived items and normal edit navigation.
