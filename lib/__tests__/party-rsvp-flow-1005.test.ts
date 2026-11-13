import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// #1005 PR 3b: reusable WhatsApp RSVP form: static Flow, send-time data, response reader,
// guest-count helper, v3 token and the separate switch.
import {
  PARTY_RSVP_FLOW_SLOTS, partyRsvpFlowJson, partyRsvpFlowRevision, buildPartyRsvpFlowData, readPartyRsvpFlowResponse,
} from '@/lib/parties/rsvp-flow';
import { maxPlusOnes } from '@/lib/parties/guest-capacity';
import {
  generatePartyRsvpFlowToken, authenticatePartyRsvpFlowToken, generateNativeFlowToken, authenticateNativeFlowToken,
} from '@/lib/whatsapp-forms/flow-token';
import { partyRsvpFormsEnabled, nativeFormsEnabled } from '@/lib/whatsapp-forms/release-gate';
import type { PartyQuestion } from '@/lib/parties/rsvp-questions';

const questions: PartyQuestion[] = [
  { id: 'side', label: 'Which side are you from?', type: 'single_choice', required: true,
    options: [{ id: 'groom', label: "Groom's family" }, { id: 'bride', label: "Bride's family" }] },
  { id: 'veg', label: 'Are you vegetarian?', type: 'yes_no', required: false },
  { id: 'song', label: 'Song request?', type: 'short_text', required: true },
];
const screen = () => (partyRsvpFlowJson().screens as Record<string, any>[])[0];
const build = (extra: Partial<Parameters<typeof buildPartyRsvpFlowData>[0]> = {}) =>
  buildPartyRsvpFlowData({ partyName: 'Ada\'s wedding', questions, askDietary: true, maxPlusOnes: 2, ...extra })!;

describe('static Flow JSON', () => {
  it('has one screen, 10 question slots and stays under the 50-component screen limit', () => {
    const s = screen();
    expect(PARTY_RSVP_FLOW_SLOTS).toBe(10);
    expect(partyRsvpFlowJson().version).toBe('7.3');
    expect(s.layout.children.length).toBeLessThanOrEqual(50);
    expect(s.layout.children.filter((c: any) => c.type === 'TextInput')).toHaveLength(10);
    expect(s.layout.children.filter((c: any) => c.type === 'RadioButtonsGroup')).toHaveLength(10);
  });

  it('every ${data.*} reference is declared, and every payload value reads a named component', () => {
    const s = screen();
    const json = JSON.stringify(s.layout);
    const refs = [...json.matchAll(/\$\{data\.([a-z0-9_]+)\}/g)].map(m => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(s.data).toHaveProperty(r);
    for (const key of Object.keys(s.data)) expect(refs).toContain(key);
    const names = new Set(s.layout.children.filter((c: any) => c.name).map((c: any) => c.name));
    const footer = s.layout.children.at(-1);
    expect(footer.type).toBe('Footer');
    for (const [k, v] of Object.entries(footer['on-click-action'].payload)) {
      expect(names.has(k)).toBe(true); expect(v).toBe(`\${form.${k}}`);
    }
  });

  it('static labels fit WhatsApp limits; the revision is a stable SHA-256', () => {
    for (const c of screen().layout.children) {
      if (typeof c.label === 'string' && !c.label.startsWith('$')) expect(c.label.length).toBeLessThanOrEqual(20);
    }
    expect(partyRsvpFlowRevision()).toMatch(/^[a-f0-9]{64}$/);
    expect(partyRsvpFlowRevision()).toBe(partyRsvpFlowRevision());
  });
});

describe('send-time data', () => {
  it('provides exactly the declared keys, with the right types', () => {
    const data = build(); const declared = screen().data;
    expect(Object.keys(data).sort()).toEqual(Object.keys(declared).sort());
    for (const [k, v] of Object.entries(data)) {
      const t = declared[k].type;
      expect(t === 'array' ? Array.isArray(v) : typeof v).toBe(t === 'array' ? true : t);
      if (t === 'array') expect((v as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it('puts question N in slot N and hides unused slots', () => {
    const d = build();
    expect(d).toMatchObject({
      q1_visible: true, q1_text: 'Which side are you from?', q1_c_visible: true, q1_c_required: true, q1_t_visible: false,
      q1_options: [{ id: 'groom', title: "Groom's family" }, { id: 'bride', title: "Bride's family" }],
      q2_visible: true, q2_c_visible: true, q2_c_required: false, q2_options: [{ id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }],
      q3_visible: true, q3_t_visible: true, q3_t_required: true, q3_c_visible: false, q3_c_required: false,
      q4_visible: false, q4_t_visible: false, q4_c_visible: false, q4_t_required: false, q4_c_required: false,
      dietary_visible: true,
    });
    expect(d.intro).toContain("Ada's wedding");
  });

  it('offers guest counts from the capacity helper; 0 hides the choice', () => {
    expect(build().guest_options).toEqual([{ id: '0', title: 'Just me' }, { id: '1', title: 'Me + 1 guest' }, { id: '2', title: 'Me + 2 guests' }]);
    expect(build({ maxPlusOnes: 0 })).toMatchObject({ guests_visible: false });
    expect(build({ askDietary: false }).dietary_visible).toBe(false);
  });

  it('returns null (web link fallback) when the party cannot be shown faithfully', () => {
    const long = { ...questions[0], options: [{ id: 'a', label: 'x'.repeat(31) }, { id: 'b', label: 'B' }] } as PartyQuestion;
    expect(buildPartyRsvpFlowData({ partyName: 'P', questions: [long], askDietary: false, maxPlusOnes: 0 })).toBeNull();
    expect(buildPartyRsvpFlowData({ partyName: 'P', questions: [], askDietary: false, maxPlusOnes: 0 })).toBeNull();
    expect(buildPartyRsvpFlowData({ partyName: 'P', questions: Array(11).fill(questions[1]), askDietary: false, maxPlusOnes: 0 })).toBeNull();
  });
});

describe('reading the response', () => {
  const ok = { flow_token: 't', guests: '2', dietary: '  no nuts ', q1_c: 'bride', q2_c: 'yes', q3_t: ' Dance ', q4_t: 'ignored' };
  it('maps slots back to question IDs as an M489 accepted payload', () => {
    expect(readPartyRsvpFlowResponse(ok, questions, true)).toEqual({
      status: 'accepted', plus_ones: 2, dietary_notes: 'no nuts', answers: { side: 'bride', veg: true, song: 'Dance' },
    });
    expect(readPartyRsvpFlowResponse({ ...ok, q2_c: 'no' }, questions, true).answers.veg).toBe(false);
  });
  it('rejects a missing required answer or an unknown choice; optional answers may be left out', () => {
    expect(() => readPartyRsvpFlowResponse({ ...ok, q3_t: '   ' }, questions, true)).toThrow('Song request?');
    expect(() => readPartyRsvpFlowResponse({ ...ok, q1_c: 'cousin' }, questions, true)).toThrow();
    expect(readPartyRsvpFlowResponse({ ...ok, q2_c: '' }, questions, true).answers).not.toHaveProperty('veg');
  });
  it('guest count must be digits; dietary notes only when the party asks', () => {
    expect(() => readPartyRsvpFlowResponse({ ...ok, guests: '-1' }, questions, true)).toThrow('how many');
    expect(readPartyRsvpFlowResponse({ ...ok, guests: '' }, questions, true).plus_ones).toBe(0);
    expect(readPartyRsvpFlowResponse(ok, questions, false)).not.toHaveProperty('dietary_notes');
    expect(readPartyRsvpFlowResponse({ ...ok, dietary: '  ' }, questions, true).dietary_notes).toBeNull();
    expect(readPartyRsvpFlowResponse({ ...ok, dietary: undefined }, questions, true).dietary_notes).toBeNull();
  });
});

describe('guest-count helper (same rules as M489 and M457)', () => {
  it('honours allow_plus_ones, max_plus_ones (default 3) and remaining capacity', () => {
    expect(maxPlusOnes({ allow_plus_ones: false, max_plus_ones: 5 }, 0)).toBe(0);
    expect(maxPlusOnes({ allow_plus_ones: true, max_plus_ones: null }, 0)).toBe(3);
    expect(maxPlusOnes({ allow_plus_ones: true, max_plus_ones: 5 }, 0)).toBe(5);
    expect(maxPlusOnes({ allow_plus_ones: true, max_plus_ones: 0 }, 0)).toBe(0);
    expect(maxPlusOnes({ allow_plus_ones: true, max_plus_ones: 5, max_guests: 10 }, 7)).toBe(2);
    expect(maxPlusOnes({ allow_plus_ones: true, max_plus_ones: 5, max_guests: 10 }, 10)).toBe(0);
    expect(maxPlusOnes({ allow_plus_ones: true, max_plus_ones: 5, max_guests: 0 }, 100)).toBe(5);
  });
});

describe('v3 party RSVP token', () => {
  const claims = {
    inviteId: '00000000-0000-4000-a540-000000000001', businessId: '00000000-0000-4000-a540-000000000002',
    publicationId: '00000000-0000-4000-a540-000000000003', channelId: '00000000-0000-4000-a540-000000000004',
    phoneNumberId: '1234567', assetId: '7654321', questionRevision: 4, phone: '+2348031234567',
  };
  beforeEach(() => { vi.stubEnv('FLOW_TOKEN_SECRET', 's'.repeat(40)); });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

  it('round-trips only for the bound sender, channel and number, for 24 hours', () => {
    const { token, expiresAt } = generatePartyRsvpFlowToken(claims);
    expect(expiresAt - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
    expect(authenticatePartyRsvpFlowToken(token, '2348031234567', claims.channelId, claims.phoneNumberId))
      .toMatchObject({ ...claims, phone: '2348031234567' });
    expect(authenticatePartyRsvpFlowToken(token, '2348030000000', claims.channelId, claims.phoneNumberId)).toBeNull();
    expect(authenticatePartyRsvpFlowToken(token, '2348031234567', '00000000-0000-4000-a540-000000000009', claims.phoneNumberId)).toBeNull();
    expect(authenticatePartyRsvpFlowToken(token, '2348031234567', claims.channelId, '999')).toBeNull();
    vi.useFakeTimers(); vi.setSystemTime(expiresAt + 1);
    expect(authenticatePartyRsvpFlowToken(token, '2348031234567', claims.channelId, claims.phoneNumberId)).toBeNull();
  });

  it('rejects tampering, a wrong secret, and the other token versions in both directions', () => {
    const { token } = generatePartyRsvpFlowToken(claims);
    const [p, s] = token.split('.');
    const forged = Buffer.from(Buffer.from(p, 'base64url').toString().replace('"questionRevision":4', '"questionRevision":5')).toString('base64url');
    expect(authenticatePartyRsvpFlowToken(`${forged}.${s}`, '2348031234567', claims.channelId, claims.phoneNumberId)).toBeNull();
    expect(authenticateNativeFlowToken(token, '2348031234567', claims.channelId, claims.phoneNumberId)).toBeNull();
    const v2 = generateNativeFlowToken({ formId: claims.inviteId, businessId: claims.businessId, publicationId: claims.publicationId,
      channelId: claims.channelId, phoneNumberId: claims.phoneNumberId, assetId: claims.assetId, revision: 'a'.repeat(64), phone: claims.phone }).token;
    expect(authenticatePartyRsvpFlowToken(v2, '2348031234567', claims.channelId, claims.phoneNumberId)).toBeNull();
    vi.stubEnv('FLOW_TOKEN_SECRET', 't'.repeat(40));
    expect(authenticatePartyRsvpFlowToken(token, '2348031234567', claims.channelId, claims.phoneNumberId)).toBeNull();
    expect(() => generatePartyRsvpFlowToken({ ...claims, questionRevision: -1 })).toThrow();
  });
});

describe('switch', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('is off by default and independent of merchant native forms', () => {
    vi.stubEnv('WHATSAPP_PARTY_RSVP_FORMS_ENABLED', '');
    vi.stubEnv('WHATSAPP_NATIVE_FORMS_ENABLED', 'true');
    expect(partyRsvpFormsEnabled()).toBe(false); expect(nativeFormsEnabled()).toBe(true);
    vi.stubEnv('WHATSAPP_PARTY_RSVP_FORMS_ENABLED', 'true');
    vi.stubEnv('WHATSAPP_NATIVE_FORMS_ENABLED', '');
    expect(partyRsvpFormsEnabled()).toBe(true); expect(nativeFormsEnabled()).toBe(false);
  });
});
