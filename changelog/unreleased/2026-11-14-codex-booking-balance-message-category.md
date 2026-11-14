## 2026-11-14 — Restore booking balance request message authorization

- Booking Request balance now supplies the existing `service` category for its free-form transactional WhatsApp message, satisfying the sender financial authorization contract.
- The change is limited to `app/api/bookings/request-balance/route.ts` and follows the existing message-category decision in #722.
- Executable route coverage verifies successful categorized delivery, server-calculated balance, deposit-link preservation, and denied financial/ownership/capability paths. Neighboring category and capability assertions also pass locally.
- Could break the balance-request notification if its category stops matching the financial guard contract. The focused regression exercises this boundary with a category-enforcing sender double.
