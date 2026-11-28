/**
 * #1175 Q13 A, F6 in WhatsApp onboarding.
 * - The Flow's owner-details "Next" asks Waaiio to check the length: too
 *   short stays on the screen with W3; otherwise moves to business details.
 * - At the end, a new account with a refused password gets a WhatsApp message
 *   (W3 for an older published Flow without the screen check, W4 for a
 *   breach-list refusal) with the website link, and no account is created.
 * - An existing auth account keeps today's path; the auth record, not the
 *   profile row, decides whether one exists. A breach-list refusal never
 *   attaches to anything.
 * Real handlers; Supabase and the channel sender are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AuthWeakPasswordError, AuthApiError } from '@supabase/auth-js';

const W3 = 'Use at least 8 characters.';
const W4 = "This password has appeared in a data breach elsewhere, so it isn't safe. Please choose a different one.";
const LINK = 'https://www.waaiio.com/get-started';

const m = vi.hoisted(() => ({
  createUser: vi.fn(),
  existingProfile: null as { id: string } | null,
  authEmails: [] as string[],
  listUsers: vi.fn(),
  sendText: vi.fn(async () => ({})),
  bizCountQueried: vi.fn(),
}));

vi.mock('@/lib/channels/operation-admission', () => ({ channelOperationsEnabled: () => true, CHANNEL_OPERATIONS_UNAVAILABLE: { message: 'x' } }));
vi.mock('@/lib/signup-gate', () => ({ isSignupOpen: async () => true }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ max_businesses_per_user: 0 }) }));
vi.mock('@/lib/capabilities/service', () => ({ initCapabilities: vi.fn(async () => {}) }));
vi.mock('@/lib/onboarding/whatsapp-readiness', () => ({ allocateSharedChannelForNewBusiness: vi.fn(), SHARED_CHANNEL_FALLBACK_COUNTRIES: {} }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class { async getSharedChannelForCountry() { return { sender: { sendText: m.sendText } }; } },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    auth: { admin: { createUser: m.createUser, listUsers: m.listUsers } },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = () => { m.bizCountQueried(table); return Promise.resolve({ count: 1 }); };
      chain.single = async () => ({ data: table === 'profiles' ? m.existingProfile : null });
      return chain;
    },
  }),
}));

const TOKEN = 'onboarding:+2348011112222';
const base = { first_name: 'Ada', last_name: 'O', email: 'ada@example.com', business_name: 'Ada Salon', category: 'salon', country: 'NG', city: 'Lagos', capabilities: ['scheduling'] };

async function complete(password: string) {
  const { handleOnboardingComplete } = await import('@/app/api/whatsapp/flow-callback/onboarding');
  return handleOnboardingComplete(TOKEN, { ...base, password });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.existingProfile = null;
  m.authEmails = [];
  m.listUsers.mockImplementation(async () => ({ data: { users: m.authEmails.map((email, i) => ({ id: `auth-${i}`, email })) }, error: null }));
  m.createUser.mockResolvedValue({ data: { user: { id: 'new-user' } }, error: null });
});

describe('Flow owner-details screen (data exchange)', () => {
  it('a 7-character password stays on the screen with W3', async () => {
    const { handleOnboardingDataExchange } = await import('@/app/api/whatsapp/flow-data/onboarding');
    expect(handleOnboardingDataExchange('data_exchange', 'OWNER_DETAILS', { password: 'seven77' }))
      .toEqual({ screen: 'OWNER_DETAILS', data: { password_error: W3 } });
  });

  it('an 8-character password moves on to business details with the lists', async () => {
    const { handleOnboardingDataExchange } = await import('@/app/api/whatsapp/flow-data/onboarding');
    const res = handleOnboardingDataExchange('data_exchange', 'OWNER_DETAILS', { password: 'eight888' }) as { screen: string; data: { categories: unknown[]; countries: unknown[] } };
    expect(res.screen).toBe('BUSINESS_DETAILS');
    expect(res.data.categories.length).toBeGreaterThan(0);
    expect(res.data.countries).toEqual(expect.arrayContaining([{ id: 'NG', title: '🇳🇬 Nigeria' }]));
  });

  it('INIT and BUSINESS_DETAILS answers are unchanged', async () => {
    const { handleOnboardingDataExchange } = await import('@/app/api/whatsapp/flow-data/onboarding');
    expect((handleOnboardingDataExchange('INIT', null, {}) as { screen: string }).screen).toBe('WELCOME');
    expect((handleOnboardingDataExchange('data_exchange', 'BUSINESS_DETAILS', { category: 'salon' }) as { screen: string }).screen).toBe('FEATURES');
  });

  it('the Flow definition sends the password to Waaiio from owner details and shows the rule', () => {
    const flow = JSON.parse(readFileSync(join(process.cwd(), 'lib/whatsapp-flows/onboarding-flow.json'), 'utf8'));
    const owner = flow.screens.find((s: { id: string }) => s.id === 'OWNER_DETAILS');
    const children = owner.layout.children as Array<Record<string, any>>;
    const password = children.find((c) => c.name === 'password')!;
    expect(password['helper-text']).toBe(W3);
    expect(password['error-message']).toBe('${data.password_error}');
    const footer = children.find((c) => c.type === 'Footer')!;
    expect(footer['on-click-action']).toEqual({ name: 'data_exchange', payload: { screen: 'OWNER_DETAILS', password: '${form.password}' } });
    expect(owner.data.password_error.type).toBe('string');
    // WELCOME supplies the screen's data when navigating to it.
    const welcome = flow.screens.find((s: { id: string }) => s.id === 'WELCOME');
    const welcomeFooter = (welcome.layout.children as Array<Record<string, any>>).find((c) => c.type === 'Footer')!;
    expect(welcomeFooter['on-click-action'].payload).toEqual({ password_error: '' });
  });
});

describe('Flow completion', () => {
  it('older Flow, new email, 7 characters: no account; WhatsApp W3 with the website link', async () => {
    const res = await complete('seven77');
    expect(res.success).toBe(false);
    expect(m.createUser).not.toHaveBeenCalled();
    expect(m.sendText).toHaveBeenCalledWith({ to: '2348011112222', text: `${W3}\n\n${LINK}` });
  });

  it('breach-list refusal for a new email: no account; WhatsApp W4 with the website link', async () => {
    m.createUser.mockResolvedValue({ data: { user: null }, error: new AuthWeakPasswordError('Password is known to be weak', 422, ['pwned']) });
    const res = await complete('password1');
    expect(res).toEqual({ success: false, error: 'Password refused' });
    expect(m.sendText).toHaveBeenCalledWith({ to: '2348011112222', text: `${W4}\n\n${LINK}` });
    expect(m.bizCountQueried).not.toHaveBeenCalled();
  });

  it('8 characters, new email: the account is created and set-up continues', async () => {
    const res = await complete('eight888');
    expect(m.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'ada@example.com', password: 'eight888' }));
    expect(m.bizCountQueried).toHaveBeenCalledWith('businesses');
    expect(m.sendText).not.toHaveBeenCalled();
    expect(res.error).toMatch(/Maximum number of businesses/); // stopped by the mocked limit after the account step
  });

  it('existing auth account with a short password keeps today’s path (no new account, no notice)', async () => {
    m.authEmails = ['ada@example.com'];
    m.existingProfile = { id: 'existing-user' };
    await complete('six666');
    expect(m.createUser).not.toHaveBeenCalled();
    expect(m.sendText).not.toHaveBeenCalled();
    expect(m.bizCountQueried).toHaveBeenCalledWith('businesses');
  });

  it('short password, a profile row with this email but no auth account: nothing is attached; W3 notice', async () => {
    m.existingProfile = { id: 'someone-else' };
    const res = await complete('six666');
    expect(res).toEqual({ success: false, error: 'Password does not meet the rule' });
    expect(m.bizCountQueried).not.toHaveBeenCalled();
    expect(m.createUser).not.toHaveBeenCalled();
    expect(m.sendText).toHaveBeenCalledWith({ to: '2348011112222', text: `${W3}\n\n${LINK}` });
  });

  it('short password, auth account exists but no profile row: refused as already registered, as before', async () => {
    m.authEmails = ['ada@example.com'];
    const res = await complete('six666');
    expect(res).toEqual({ success: false, error: 'Email already registered. Please log in at waaiio.com' });
    expect(m.bizCountQueried).not.toHaveBeenCalled();
    expect(m.sendText).not.toHaveBeenCalled();
  });

  it('breach-list refusal never attaches, even when a profile row has this email', async () => {
    m.existingProfile = { id: 'someone-else' };
    m.createUser.mockResolvedValue({ data: { user: null }, error: new AuthWeakPasswordError('weak', 422, ['pwned']) });
    const res = await complete('password1');
    expect(res).toEqual({ success: false, error: 'Password refused' });
    expect(m.bizCountQueried).not.toHaveBeenCalled();
    expect(m.sendText).toHaveBeenCalledWith({ to: '2348011112222', text: `${W4}\n\n${LINK}` });
  });

  it('the auth lookup failing stops onboarding (fails closed), with nothing created or attached', async () => {
    m.listUsers.mockResolvedValue({ data: { users: [] }, error: { message: 'down' } });
    const res = await complete('six666');
    expect(res.success).toBe(false);
    expect(m.createUser).not.toHaveBeenCalled();
    expect(m.bizCountQueried).not.toHaveBeenCalled();
  });

  it('an already-registered email is handled as before', async () => {
    m.existingProfile = { id: 'existing-user' };
    m.createUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError('A user with this email address has already been registered', 422, 'email_exists') });
    await complete('eight888');
    expect(m.sendText).not.toHaveBeenCalled();
    expect(m.bizCountQueried).toHaveBeenCalledWith('businesses');
  });
});
