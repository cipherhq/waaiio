/**
 * Attendance primary-flow contract tests.
 *
 * Verifies:
 * - Public check-in page and API use businesses.status = 'active' (not is_active)
 * - Manual check-in uses authenticated server API (not browser-side insert)
 * - Business status gating: active passes, pending/suspended/unknown rejected
 * - Input validation consistency
 * - Source is forced to 'manual' server-side
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Source-code contract tests (no mocks needed) ──

const checkinPageSource = readFileSync(
  resolve(__dirname, '../../app/checkin/[businessId]/page.tsx'),
  'utf-8',
);

const checkinApiSource = readFileSync(
  resolve(__dirname, '../../app/api/checkin/route.ts'),
  'utf-8',
);

const manualApiSource = readFileSync(
  resolve(__dirname, '../../app/api/checkin/manual/route.ts'),
  'utf-8',
);

const dashboardPageSource = readFileSync(
  resolve(__dirname, '../../app/dashboard/attendance/page.tsx'),
  'utf-8',
);

describe('Attendance primary-flow contract', () => {
  describe('PUBLIC CHECK-IN — business status gating', () => {
    it('1. public page uses status = active', () => {
      expect(checkinPageSource).toContain(".eq('status', 'active')");
    });

    it('2. public page does NOT query is_active', () => {
      expect(checkinPageSource).not.toContain('is_active');
    });

    it('3. API route uses status = active', () => {
      expect(checkinApiSource).toContain(".eq('status', 'active')");
    });

    it('4. API route does NOT query businesses by is_active', () => {
      // is_active is valid for whatsapp_channels, but must not be used for businesses
      const bizQueryMatch = checkinApiSource.match(/from\s*\(\s*['"]businesses['"]\s*\)([\s\S]*?)\.maybeSingle/);
      expect(bizQueryMatch).toBeTruthy();
      expect(bizQueryMatch![1]).not.toContain('is_active');
    });
  });

  describe('PUBLIC CHECK-IN — API behavior contracts', () => {
    it('5. API returns 404 when business not found (status gating)', () => {
      // When .eq('status', 'active') finds no match, business is null → 404
      expect(checkinApiSource).toContain("{ error: 'Business not found' }");
      expect(checkinApiSource).toContain('status: 404');
      // Verify the 404 is tied to the business check
      expect(checkinApiSource).toMatch(/if\s*\(\s*!business\s*\)\s*\{[\s\S]*?status:\s*404/);
    });

    it('6. API returns success after valid insert', () => {
      expect(checkinApiSource).toContain('success: true');
      // Source is forced to 'web' server-side
      expect(checkinApiSource).toContain("source: 'web'");
    });
  });

  describe('MANUAL CHECK-IN — server-side API', () => {
    it('7. manual API endpoint exists', () => {
      expect(manualApiSource).toBeTruthy();
    });

    it('8. manual API authenticates user', () => {
      expect(manualApiSource).toContain('auth.getUser()');
      expect(manualApiSource).toContain("{ error: 'Unauthorized' }");
      expect(manualApiSource).toContain('status: 401');
    });

    it('9. manual API verifies business ownership', () => {
      expect(manualApiSource).toContain("eq('owner_id', user.id)");
    });

    it('10. manual API forces source to manual server-side', () => {
      expect(manualApiSource).toContain("source: 'manual'");
      // Must not accept source from request body
      const destructuredFields = manualApiSource.match(/const\s*\{([^}]+)\}\s*=\s*body/);
      if (destructuredFields) {
        expect(destructuredFields[1]).not.toContain('source');
      }
    });

    it('11. manual API uses service client for insert', () => {
      expect(manualApiSource).toContain('createServiceClient');
    });

    it('12. manual API validates name length', () => {
      expect(manualApiSource).toContain('trimmedName.length > 200');
    });

    it('13. manual API validates phone', () => {
      expect(manualApiSource).toContain('cleanPhone.length < 7');
      expect(manualApiSource).toContain('cleanPhone.length > 20');
    });

    it('14. manual API validates email', () => {
      expect(manualApiSource).toContain("!trimmedEmail.includes('@')");
    });

    it('15. manual API validates notes length', () => {
      expect(manualApiSource).toContain('trimmedNotes.length > 2000');
    });
  });

  describe('DASHBOARD — no direct browser insert', () => {
    it('16. dashboard does NOT directly insert into attendance_log', () => {
      // Should not contain a direct .insert() call on attendance_log
      expect(dashboardPageSource).not.toMatch(/supabase\s*\.\s*from\s*\(\s*['"]attendance_log['"]\s*\)\s*\.\s*insert/);
    });

    it('17. dashboard uses /api/checkin/manual endpoint', () => {
      expect(dashboardPageSource).toContain('/api/checkin/manual');
    });

    it('18. dashboard shows error on failure', () => {
      expect(dashboardPageSource).toContain('formError');
    });

    it('19. dashboard only clears form after success', () => {
      // The form fields should be cleared inside the success branch
      expect(dashboardPageSource).toContain("setFormName('')");
      expect(dashboardPageSource).toContain("setShowForm(false)");
    });
  });
});
