/**
 * Embedded Signup v4 Migration Tests (#265)
 *
 * Verifies the v2→v4 client-side migration:
 * - No sessionInfoVersion in any client FB.login config
 * - No featureType in any client FB.login config
 * - extras is exactly {} in both call sites
 * - response_type is 'code' in both call sites (no 'code token')
 * - override_default_response_type is true
 * - config_id is present
 * - Server routes remain compatible
 * - Cancel path does not invoke server mutation
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Source file contents ──
const onboardingWizard = readFileSync(
  join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'), 'utf-8'
);
const connectPage = readFileSync(
  join(process.cwd(), 'app/dashboard/whatsapp/connect/page.tsx'), 'utf-8'
);
const discoverRoute = readFileSync(
  join(process.cwd(), 'app/api/auth/facebook/discover/route.ts'), 'utf-8'
);
const callbackRoute = readFileSync(
  join(process.cwd(), 'app/api/auth/facebook/callback/route.ts'), 'utf-8'
);

// ══════════════════════════════════════════════════════════
// 1. Structural guards — forbidden v2/v3 parameters removed
// ══════════════════════════════════════════════════════════

describe('v4 structural guards', () => {
  it('no sessionInfoVersion in OnboardingWizard', () => {
    expect(onboardingWizard).not.toContain('sessionInfoVersion');
  });

  it('no sessionInfoVersion in connect page', () => {
    expect(connectPage).not.toContain('sessionInfoVersion');
  });

  it('no featureType in OnboardingWizard FB.login config', () => {
    // featureType should not appear in the FB.login options block
    // (it may appear in other unrelated contexts like flow_type)
    const fbLoginBlock = onboardingWizard.slice(
      onboardingWizard.indexOf('window.FB.login'),
      onboardingWizard.indexOf('window.FB.login') + 500
    );
    expect(fbLoginBlock).not.toContain('featureType');
  });

  it('no featureType in connect page FB.login config', () => {
    const fbLoginBlock = connectPage.slice(
      connectPage.indexOf('window.FB.login'),
      connectPage.indexOf('window.FB.login') + 500
    );
    expect(fbLoginBlock).not.toContain('featureType');
  });
});

// ══════════════════════════════════════════════════════════
// 2. FB.login options — v4 compliant
// ══════════════════════════════════════════════════════════

describe('FB.login options v4 compliance', () => {
  describe('Site A — OnboardingWizard', () => {
    // The FB.login options are on separate lines in this file
    it('has config_id in FB.login options', () => {
      expect(onboardingWizard).toContain('config_id: configId');
    });

    it('response_type is code', () => {
      // Must have 'code' as response_type, not 'code token'
      expect(onboardingWizard).toContain("response_type: 'code'");
      expect(onboardingWizard).not.toContain("response_type: 'code token'");
    });

    it('override_default_response_type is true', () => {
      expect(onboardingWizard).toContain('override_default_response_type: true');
    });

    it('extras is exactly {}', () => {
      expect(onboardingWizard).toContain('extras: {}');
    });
  });

  describe('Site B — connect page', () => {
    it('has config_id in FB.login options', () => {
      expect(connectPage).toContain('config_id: configId');
    });

    it('response_type is code (not code token)', () => {
      expect(connectPage).toContain("response_type: 'code'");
      expect(connectPage).not.toContain("response_type: 'code token'");
    });

    it('override_default_response_type is true', () => {
      expect(connectPage).toContain('override_default_response_type: true');
    });

    it('extras is exactly {}', () => {
      expect(connectPage).toContain('extras: {}');
    });
  });
});

// ══════════════════════════════════════════════════════════
// 3. Code-only server exchange — no browser token trust
// ══════════════════════════════════════════════════════════

describe('code-only server exchange', () => {
  it('connect page sends code only to discover endpoint (no access_token)', () => {
    // The callback handler should send { code } not { code, access_token }
    const fetchBlock = connectPage.slice(
      connectPage.indexOf("fetch('/api/auth/facebook/discover'"),
      connectPage.indexOf("fetch('/api/auth/facebook/discover'") + 300
    );
    expect(fetchBlock).toContain('JSON.stringify({ code })');
    expect(fetchBlock).not.toContain('access_token: response.authResponse.accessToken');
  });

  it('connect page extracts code from authResponse (not accessToken)', () => {
    // Should use response.authResponse.code, not accessToken
    const callbackBlock = connectPage.slice(
      connectPage.indexOf('if (response.authResponse)'),
      connectPage.indexOf('if (response.authResponse)') + 200
    );
    expect(callbackBlock).toContain('response.authResponse.code');
    expect(callbackBlock).not.toContain('response.authResponse.accessToken || response.authResponse.code');
  });
});

// ══════════════════════════════════════════════════════════
// 4. Server route compatibility
// ══════════════════════════════════════════════════════════

describe('server route compatibility', () => {
  it('discover route accepts code parameter', () => {
    expect(discoverRoute).toContain('code');
  });

  it('discover route performs server-side code exchange', () => {
    expect(discoverRoute).toContain('oauth/access_token');
  });

  it('callback route accepts business_id and waba_id', () => {
    expect(callbackRoute).toContain('business_id');
    expect(callbackRoute).toContain('waba_id');
  });

  it('callback route verifies business ownership', () => {
    // Should check owner_id = user.id or similar ownership verification
    expect(callbackRoute).toContain('owner_id');
  });
});

// ══════════════════════════════════════════════════════════
// 5. Cancel/error path — no server mutation
// ══════════════════════════════════════════════════════════

describe('cancel path safety', () => {
  it('OnboardingWizard handles cancel without server call', () => {
    // The else branch of !response.authResponse should NOT fetch any API
    const cancelBlock = onboardingWizard.slice(
      onboardingWizard.indexOf('!response.authResponse'),
      onboardingWizard.indexOf('!response.authResponse') + 200
    );
    expect(cancelBlock).not.toContain('fetch(');
  });

  it('connect page handles cancel without server call', () => {
    // The else branch sets error and stops connecting
    const afterLogin = connectPage.slice(
      connectPage.indexOf("} else { setFbConnecting(false)"),
      connectPage.indexOf("} else { setFbConnecting(false)") + 100
    );
    expect(afterLogin).toContain('setFbConnecting(false)');
    expect(afterLogin).not.toContain('fetch(');
  });
});

// ══════════════════════════════════════════════════════════
// 6. Both FB.login call sites exist and are preserved
// ══════════════════════════════════════════════════════════

describe('call site preservation', () => {
  it('OnboardingWizard has exactly one FB.login call', () => {
    const matches = onboardingWizard.match(/window\.FB\.login\(/g);
    expect(matches).toHaveLength(1);
  });

  it('connect page has exactly one FB.login call', () => {
    const matches = connectPage.match(/window\.FB\.login\(/g);
    expect(matches).toHaveLength(1);
  });
});
