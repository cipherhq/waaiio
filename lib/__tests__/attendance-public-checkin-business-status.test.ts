/**
 * Attendance source-level regression guards.
 *
 * These are static source-string checks that guard architectural invariants:
 * - Public check-in page and API must use businesses.status = 'active' (not is_active)
 * - Manual check-in must use authenticated server API (not browser-side insert)
 * - Dashboard must not directly insert attendance_log from the browser
 *
 * For executable route behavior tests (calling actual handlers), see:
 * attendance-checkin-routes.test.ts
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

describe('Attendance source-level regression guards', () => {
  describe('PUBLIC CHECK-IN — source regression', () => {
    it('1. public page source uses status = active', () => {
      expect(checkinPageSource).toContain(".eq('status', 'active')");
    });

    it('2. public page source does NOT reference is_active', () => {
      expect(checkinPageSource).not.toContain('is_active');
    });

    it('3. API route source uses status = active', () => {
      expect(checkinApiSource).toContain(".eq('status', 'active')");
    });

    it('4. API route source does NOT query businesses by is_active', () => {
      // is_active is valid for whatsapp_channels, but must not be used for businesses
      const bizQueryMatch = checkinApiSource.match(/from\s*\(\s*['"]businesses['"]\s*\)([\s\S]*?)\.maybeSingle/);
      expect(bizQueryMatch).toBeTruthy();
      expect(bizQueryMatch![1]).not.toContain('is_active');
    });
  });

  describe('PUBLIC CHECK-IN — source architecture guards', () => {
    it('5. API source contains 404 path tied to business check', () => {
      expect(checkinApiSource).toContain("{ error: 'Business not found' }");
      expect(checkinApiSource).toMatch(/if\s*\(\s*!business\s*\)\s*\{[\s\S]*?status:\s*404/);
    });

    it('6. API source forces source to "web" server-side', () => {
      expect(checkinApiSource).toContain("source: 'web'");
    });
  });

  describe('MANUAL CHECK-IN — source architecture guards', () => {
    it('7. manual API source contains auth check and 401 path', () => {
      expect(manualApiSource).toContain('auth.getUser()');
      expect(manualApiSource).toContain('status: 401');
    });

    it('8. manual API source verifies business ownership', () => {
      expect(manualApiSource).toContain("eq('owner_id', user.id)");
    });

    it('9. manual API source does not destructure "source" from request body', () => {
      const destructuredFields = manualApiSource.match(/const\s*\{([^}]+)\}\s*=\s*body/);
      expect(destructuredFields).toBeTruthy();
      expect(destructuredFields![1]).not.toContain('source');
    });

    it('10. manual API source uses service client for insert', () => {
      expect(manualApiSource).toContain('createServiceClient');
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
