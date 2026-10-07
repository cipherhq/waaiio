/**
 * Minimal Supabase mock for tests that construct MetaCloudSender.
 *
 * #261: Business-scoped sends require a Supabase client for attempt/financial
 * authority. Tests that don't exercise the financial path use this mock to
 * satisfy the null check while keeping attempt recording in gate-OFF mode
 * (createAttempt returns null, financial auth skipped).
 */
export function createTestSupabase(): any {
  return {
    from: () => ({
      insert: () => ({ select: () => ({ single: () => ({ data: null, error: { message: 'test-mock-no-db' } }) }) }),
      update: () => ({ eq: () => ({ error: null }) }),
      select: () => ({ eq: () => ({ maybeSingle: () => ({ data: null, error: null }) }) }),
    }),
    rpc: () => Promise.resolve({ data: { enforcement_required: false }, error: null }),
  };
}
